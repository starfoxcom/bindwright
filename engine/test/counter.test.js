// The opt-in review counter Worker (counter/): what it accepts, refuses and reports.

import { test } from "node:test";
import assert from "node:assert/strict";

import { handle } from "../../counter/src/worker.js";
import {
  MAX_BODY_IN_BYTES,
  MAX_NEW_PROJECTS_PER_DAY,
  MAX_PER_SEND,
  MIN_SEND_GAP_IN_MILLISECONDS,
  checkSend,
} from "../../counter/src/rules.js";

const PROJECT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const NOON = Date.UTC(2026, 10, 4, 12);

/** In-memory stand-in for D1Store: the same contract, atomic because it never awaits midway. */
class MemoryStore {
  constructor() {
    this.projects = new Map();
    this.days = new Map();
  }
  async addSend({ send, country, timeInMilliseconds, gapInMilliseconds, maxNewPerDay }) {
    const day = new Date(timeInMilliseconds).toISOString().slice(0, 10);
    const known = this.projects.get(send.project);
    if (known && timeInMilliseconds - known.lastSend < gapInMilliseconds) return "too-soon";
    if (!known && (this.days.get(day) ?? 0) >= maxNewPerDay) return "day-full";
    if (!known) this.days.set(day, (this.days.get(day) ?? 0) + 1);
    const old = known ?? { checked: 0, caught: 0, deep: 0, merged: 0 };
    this.projects.set(send.project, {
      kind: send.kind,
      country,
      checked: old.checked + send.checked,
      caught: old.caught + send.caught,
      deep: old.deep + send.deep,
      merged: old.merged + send.merged,
      lastSend: timeInMilliseconds,
    });
    return "added";
  }
  async totals(limit) {
    const rows = [...this.projects.values()];
    const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
    const top = rows
      .sort((a, b) => b.checked - a.checked)
      .slice(0, limit)
      .map(({ kind, checked, caught, deep, merged }) => ({ kind, checked, caught, deep, merged }));
    return {
      projects: rows.length,
      checked: sum("checked"),
      caught: sum("caught"),
      deep: sum("deep"),
      merged: sum("merged"),
      top,
    };
  }
}

function send(fields = {}) {
  return { project: PROJECT, kind: "game", checked: 4, caught: 1, deep: 1, merged: 3, ...fields };
}

function post(body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://counter.test/increment", { method: "POST", body: text, headers });
}

async function run(request, { store = new MemoryStore(), rateLimiter, time = NOON } = {}) {
  const response = await handle(request, { store, rateLimiter, timeInMilliseconds: time });
  return { status: response.status, body: await response.json().catch(() => null), response };
}

test("checkSend accepts a valid send and refuses each bad field", () => {
  assert.equal(checkSend(send()).ok, true);
  const refused = [
    ["not an object", []],
    ["unknown field", send({ repo: "secret" })],
    ["short project id", send({ project: "abc" })],
    ["uppercase project id", send({ project: PROJECT.toUpperCase() })],
    ["free-text kind", send({ kind: "my secret game" })],
    ["negative count", send({ merged: -1 })],
    ["fraction", send({ checked: 1.5 })],
    ["one above the cap", send({ checked: MAX_PER_SEND + 1 })],
    ["caught above checked", send({ checked: 1, caught: 2 })],
    ["deep above checked", send({ checked: 1, deep: 2 })],
    ["all zero", send({ checked: 0, caught: 0, deep: 0, merged: 0 })],
  ];
  for (const [name, body] of refused) assert.equal(checkSend(body).ok, false, name);
  assert.equal(checkSend(send({ checked: MAX_PER_SEND, merged: MAX_PER_SEND })).ok, true, "cap");
});

test("a send adds to the totals, and /total reports kinds and counts only", async () => {
  const store = new MemoryStore();
  assert.equal((await run(post(send()), { store })).status, 200);
  assert.equal((await run(post(send({ project: OTHER, kind: "website", checked: 9 })), { store })).status, 200);

  const total = await run(new Request("https://counter.test/total"), { store });
  assert.equal(total.status, 200);
  assert.equal(total.response.headers.get("access-control-allow-origin"), "*");
  assert.equal(total.body.projects, 2);
  assert.equal(total.body.checked, 13);
  assert.deepEqual(total.body.top[0], { kind: "website", checked: 9, caught: 1, deep: 1, merged: 3 });
  assert.equal(JSON.stringify(total.body).includes(PROJECT), false, "project ids stay private");
});

test("a project sends once per gap", async () => {
  const store = new MemoryStore();
  await run(post(send()), { store });
  const early = await run(post(send()), { store, time: NOON + MIN_SEND_GAP_IN_MILLISECONDS - 1 });
  assert.equal(early.status, 429);
  const later = await run(post(send()), { store, time: NOON + MIN_SEND_GAP_IN_MILLISECONDS });
  assert.equal(later.status, 200);
  assert.equal(store.projects.get(PROJECT).checked, 8);
});

test("two sends for one project arriving together count once", async () => {
  const store = new MemoryStore();
  const results = await Promise.all([run(post(send()), { store }), run(post(send()), { store })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
  assert.equal(store.projects.get(PROJECT).checked, 4);
});

test("new projects stop at the daily cap, existing ones keep sending", async () => {
  const store = new MemoryStore();
  await run(post(send()), { store, time: NOON - MIN_SEND_GAP_IN_MILLISECONDS });
  store.days.set("2026-11-04", MAX_NEW_PROJECTS_PER_DAY);
  assert.equal((await run(post(send({ project: OTHER })), { store })).status, 429);
  assert.equal((await run(post(send()), { store })).status, 200);
});

test("oversized, non-JSON and rate-limited sends are refused before they count", async () => {
  const store = new MemoryStore();
  const padded = JSON.stringify(send()).padEnd(MAX_BODY_IN_BYTES + 1, " ");
  assert.equal((await run(post(padded), { store })).status, 413);
  assert.equal((await run(post("{not json"), { store })).status, 400);
  const limiter = { limit: async () => ({ success: false }) };
  assert.equal((await run(post(send()), { store, rateLimiter: limiter })).status, 429);
  assert.equal(store.projects.size, 0);
});

test("other routes and methods answer 404", async () => {
  assert.equal((await run(new Request("https://counter.test/increment"))).status, 404);
  assert.equal((await run(new Request("https://counter.test/"))).status, 404);
});

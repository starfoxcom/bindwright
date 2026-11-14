// The opt-in review counter Worker (counter/): what it accepts, refuses and reports.
// Every case runs the real handler and the real D1Store, its SQL against counter/schema.sql
// in an in-memory SQLite database behind the small part of D1's API the store uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handle } from "../../counter/src/worker.js";
import { D1Store } from "../../counter/src/store.js";
import {
  MAX_BODY_IN_BYTES,
  MAX_NEW_PROJECTS_PER_DAY,
  MAX_PER_SEND,
  MAX_ROUNDS_PER_SEND,
  MIN_SEND_GAP_IN_MILLISECONDS,
  checkSend,
  TOTALS_MAX_AGE_IN_SECONDS,
} from "../../counter/src/rules.js";

const SCHEMA = readFileSync(new URL("../../counter/schema.sql", import.meta.url), "utf8");
const PROJECT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const NOON = Date.UTC(2026, 10, 4, 12);
const DAY = 24 * 60 * 60 * 1000;
const LATER = NOON + MIN_SEND_GAP_IN_MILLISECONDS;

const isRead = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql);

/**
 * D1's prepare/bind/first/run/batch over node:sqlite. `batch` runs its statements in one
 * transaction, as D1 does, and reports `meta.changes` per statement.
 */
class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(SCHEMA);
  }

  prepare(sql) {
    const database = this;
    const statement = (params) => ({
      bind: (...values) => statement(values),
      first: async () => database.sqlite.prepare(sql).get(...params) ?? null,
      run: async () => database.execute(sql, params),
      execute: () => database.execute(sql, params),
    });
    return statement([]);
  }

  execute(sql, params) {
    const prepared = this.sqlite.prepare(sql);
    if (isRead(sql)) return { results: prepared.all(...params), meta: { changes: 0 } };
    return { results: [], meta: { changes: Number(prepared.run(...params).changes) } };
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function newStore() {
  const database = new SqliteD1();
  return { store: new D1Store(database), database };
}

function rowOf(database, id) {
  return database.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function send(fields = {}) {
  return {
    project: PROJECT, kind: "game", checked: 4, caught: 1, deep: 1, merged: 3,
    stalled: 0, rounds: 2, from: NOON - DAY, to: NOON,
    ...fields,
  };
}

function post(body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://counter.test/increment", { method: "POST", body: text, headers });
}

async function run(request, { store, rateLimiter, time = NOON }) {
  const response = await handle(request, { store, rateLimiter, timeInMilliseconds: time });
  return { status: response.status, body: await response.json().catch(() => null), response };
}

test("checkSend accepts a valid send and refuses each bad field", () => {
  assert.equal(checkSend(send()).ok, true);
  assert.equal(checkSend(send({ caught: 2, stalled: 1, rounds: 3 })).ok, true, "a stalled PR");
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
    ["all zero", send({ checked: 0, caught: 0, deep: 0, merged: 0, stalled: 0, rounds: 0 })],
    ["no window", { ...send(), from: undefined }],
    ["window ending before it starts", send({ from: NOON, to: NOON - 1 })],
    ["window as text", send({ to: String(NOON) })],
    ["stalled above caught", send({ caught: 1, stalled: 2, rounds: 12 })],
    ["rounds fewer than caught", send({ caught: 2, rounds: 1 })],
    ["rounds fewer than three per stalled PR", send({ caught: 2, stalled: 2, rounds: 5 })],
    ["rounds above their cap", send({ rounds: MAX_ROUNDS_PER_SEND + 1 })],
    ["rounds with caught at 0", send({ caught: 0, deep: 0, rounds: 1 })],
  ];
  for (const [name, body] of refused) assert.equal(checkSend(body).ok, false, name);
  const atCap = send({
    checked: MAX_PER_SEND, caught: MAX_PER_SEND, merged: MAX_PER_SEND,
    stalled: MAX_PER_SEND, rounds: MAX_ROUNDS_PER_SEND,
  });
  assert.equal(checkSend(atCap).ok, true, "cap");
});

test("a send adds to the totals, and /total reports kinds and counts only", async () => {
  const { store } = newStore();
  assert.equal((await run(post(send()), { store })).status, 200);
  const stalling = send({
    project: OTHER, kind: "website", checked: 9, caught: 2, stalled: 1, rounds: 8,
  });
  assert.equal((await run(post(stalling), { store })).status, 200);

  const total = await run(new Request("https://counter.test/total"), { store });
  assert.equal(total.status, 200);
  assert.equal(total.response.headers.get("access-control-allow-origin"), "*");
  assert.equal(total.body.projects, 2);
  assert.equal(total.body.checked, 13);
  assert.equal(total.body.stalled, 1);
  assert.equal(total.body.rounds, 10);
  assert.deepEqual(total.body.top[0], {
    kind: "website", checked: 9, caught: 2, deep: 1, merged: 3, stalled: 1, rounds: 8,
  });
  assert.equal(JSON.stringify(total.body).includes(PROJECT), false, "project ids stay private");
});

test("/total answers from its saved copy until TOTALS_MAX_AGE_IN_SECONDS passes", async () => {
  const { store } = newStore();
  const total = new Request("https://counter.test/total");
  assert.equal((await run(total, { store })).body.projects, 0, "the first read computes");
  assert.equal((await run(post(send()), { store })).status, 200);
  const maxAge = TOTALS_MAX_AGE_IN_SECONDS * 1000;
  assert.equal((await run(total, { store, time: NOON + maxAge - 1 })).body.projects, 0, "still the copy");
  assert.equal((await run(total, { store, time: NOON + maxAge })).body.projects, 1, "refreshed");
});

test("a project sends once per gap", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store });
  const early = await run(post(send({ from: NOON, to: LATER - 1 })), { store, time: LATER - 1 });
  assert.equal(early.status, 429);
  assert.equal(early.body.error, "this project already sent today");
  const later = await run(post(send({ from: NOON, to: LATER })), { store, time: LATER });
  assert.equal(later.status, 200);
  assert.equal(rowOf(database, PROJECT).checked, 8);
});

test("a resent window is refused with where the count stops, and the next window counts", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store });
  const resent = await run(post(send()), { store, time: LATER });
  assert.equal(resent.status, 409);
  assert.equal(resent.body.coveredTo, NOON);
  const overlapping = await run(post(send({ from: NOON - 1, to: LATER })), { store, time: LATER });
  assert.equal(overlapping.status, 409);
  assert.equal((await run(post(send({ from: NOON, to: LATER })), { store, time: LATER })).status, 200);
  assert.equal(rowOf(database, PROJECT).checked, 8);
});

test("two sends for one project arriving together count once", async () => {
  const { store, database } = newStore();
  const results = await Promise.all([run(post(send()), { store }), run(post(send()), { store })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(rowOf(database, PROJECT).checked, 4);
});

test("new projects stop at the daily cap, existing ones keep sending", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store, time: NOON - MIN_SEND_GAP_IN_MILLISECONDS });
  const claim = database.sqlite.prepare("INSERT INTO new_projects (day, id) VALUES ('2026-11-04', ?)");
  for (let i = 0; i < MAX_NEW_PROJECTS_PER_DAY; i += 1) claim.run(`filler${i}`);

  const refused = await run(post(send({ project: OTHER })), { store });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "too many new projects today");
  assert.equal(rowOf(database, OTHER), undefined);
  assert.equal((await run(post(send({ from: NOON, to: NOON })), { store })).status, 200, "a known project is not new");
});

test("a new day frees the cap and keeps projects from earlier days", async () => {
  const { store, database } = newStore();
  await run(post(send()), { store });
  assert.equal((await run(post(send({ from: NOON, to: NOON + DAY })), { store, time: NOON + DAY })).status, 200);
  const days = database.sqlite.prepare("SELECT DISTINCT day FROM new_projects").all().map((r) => r.day);
  assert.deepEqual(days, [], "earlier days are cleared on the next send");
  assert.equal(rowOf(database, PROJECT).checked, 8);
});

test("oversized, non-JSON and rate-limited sends are refused before they count", async () => {
  const { store, database } = newStore();
  const padded = JSON.stringify(send()).padEnd(MAX_BODY_IN_BYTES + 1, " ");
  assert.equal((await run(post(padded), { store })).status, 413);
  assert.equal((await run(post("{not json"), { store })).status, 400);
  const limiter = { limit: async () => ({ success: false }) };
  assert.equal((await run(post(send()), { store, rateLimiter: limiter })).status, 429);
  assert.equal(rowOf(database, PROJECT), undefined);
});

test("other routes and methods answer 404", async () => {
  const { store } = newStore();
  assert.equal((await run(new Request("https://counter.test/increment"), { store })).status, 404);
  assert.equal((await run(new Request("https://counter.test/"), { store })).status, 404);
});

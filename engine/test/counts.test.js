// The opt-in review counts (plugin/hooks/counts.mjs): what a repo's merged
// pull requests add up to, and what a daily send does with the counter's answer.
// Nothing here touches the network or gh: both are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS, countPrs, counterUrl, send, setProject, setShare, statusOf } from "../../plugin/hooks/counts.mjs";
import { KINDS as COUNTER_KINDS } from "../../counter/src/rules.js";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "hooks", "counts.mjs");
const SEND_URL = "http://127.0.0.1:8787/increment";
const ID = "0123456789abcdef0123456789abcdef";
const OK = { status: 200, error: "" };
const ALREADY_SENT = { status: 429, error: "this project already sent today" };
const DEEP = "needs-deep-review";

const comment = (body, login = "claude") => ({ author: { login }, body });
const pr = (comments = [], labels = []) => ({ number: 1, labels: labels.map((name) => ({ name })), comments });
const GREEN_PR = pr([comment("🟢 LGTM")]);
const red = comment("🔴 Blocking: the parser drops the last field");
const green = comment("🟢 LGTM");

// Local noon of a November 2026 day, so the local calendar day is the one named.
const noon = (day, hour = 12) => new Date(2026, 10, day, hour);

const countRows = [
  ["no merged PRs counts nothing", [], { checked: 0, caught: 0, deep: 0, merged: 0 }],
  ["a merged PR without a review counts only as merged", [pr()], { checked: 0, caught: 0, deep: 0, merged: 1 }],
  ["a green verdict counts as checked", [pr([green])], { checked: 1, caught: 0, deep: 0, merged: 1 }],
  ["a red verdict later followed by green counts as caught", [pr([red, green])],
    { checked: 1, caught: 1, deep: 0, merged: 1 }],
  ["the last verdict line of a comment decides", [pr([comment("🔴 Blocking\n🟢 LGTM")])],
    { checked: 1, caught: 0, deep: 0, merged: 1 }],
  ["a list item with a glyph is not a verdict", [pr([comment("- 🔴 Blocking: nit\n🟢 LGTM")])],
    { checked: 1, caught: 0, deep: 0, merged: 1 }],
  ["numbered list items alone give no verdict", [pr([comment("1. 🔴 Blocking\n2. 🟢 LGTM")])],
    { checked: 0, caught: 0, deep: 0, merged: 1 }],
  ["an escalation request does not count", [pr([comment("@claude review this PR: 🔴 Blocking before")])],
    { checked: 0, caught: 0, deep: 0, merged: 1 }],
  ["a comment from another author does not count", [pr([comment("🔴 Blocking", "someone")])],
    { checked: 0, caught: 0, deep: 0, merged: 1 }],
  ["the claude[bot] login counts", [pr([comment("🟢 LGTM", "claude[bot]")])],
    { checked: 1, caught: 0, deep: 0, merged: 1 }],
  ["a verdict without its glyph does not count", [pr([comment("LGTM")])],
    { checked: 0, caught: 0, deep: 0, merged: 1 }],
  ["a verdict in the middle of a sentence does not count", [pr([comment("Earlier I wrote 🟢 LGTM")])],
    { checked: 0, caught: 0, deep: 0, merged: 1 }],
  ["a deep label on a checked PR counts as deep", [pr([green], [DEEP])],
    { checked: 1, caught: 0, deep: 1, merged: 1 }],
  ["a red deep review counts as caught and deep", [pr([red], [DEEP])],
    { checked: 1, caught: 1, deep: 1, merged: 1 }],
  ["a deep label without a verdict does not count", [pr([], [DEEP])],
    { checked: 0, caught: 0, deep: 0, merged: 1 }],
  ["each count caps at 1000", Array.from({ length: 1001 }, () => pr([green], [DEEP])),
    { checked: 1000, caught: 0, deep: 1000, merged: 1000 }],
];

for (const [name, prs, expected] of countRows) {
  test(`counts: ${name}`, () => assert.deepEqual(countPrs(prs), expected));
}

test("the plugin offers exactly the kinds the counter accepts", () => {
  assert.deepEqual(KINDS, COUNTER_KINDS);
});

test("the counter URL is the live Worker unless BINDWRIGHT_COUNTER_URL names another base", () => {
  assert.equal(counterUrl({}), "https://bindwright-counter.starfoxcom.workers.dev/increment");
  assert.equal(counterUrl({ BINDWRIGHT_COUNTER_URL: "http://127.0.0.1:8787/" }), SEND_URL);
});

// A temp folder with a config folder, a repo and the state file path.
function scene() {
  const root = mkdtempSync(join(tmpdir(), "bw-counts-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "bindwright"), { recursive: true });
  return {
    repo: realpathSync(repo),
    configDir,
    stateFile: join(configDir, "bindwright", "counts.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function inScene(run) {
  const s = scene();
  try {
    await run(s);
  } finally {
    s.cleanup();
  }
}

function projectEntry(overrides = {}) {
  return {
    id: ID,
    kind: "game",
    since: noon(1).toISOString(),
    lastSendDay: null,
    failedAt: null,
    ...overrides,
  };
}

function seedState(s, { share = true, projects = { [s.repo]: projectEntry() } } = {}) {
  writeFileSync(s.stateFile, JSON.stringify({ share, projects }));
}

function projectOf(s) {
  return JSON.parse(readFileSync(s.stateFile, "utf8")).projects[s.repo];
}

// Records the repo each gh call ran in and answers with `result`, or throws it.
function fakeGh(result) {
  const calls = [];
  const ghJson = async (args, cwd) => {
    calls.push({ args, cwd });
    if (result instanceof Error) throw result;
    return result;
  };
  return { ghJson, calls };
}

// Records each post. `reply` is what it answers; an Error is thrown instead.
function fakeCounter(reply) {
  const counter = { reply, posts: [] };
  counter.post = async (url, body) => {
    counter.posts.push({ url, body });
    if (counter.reply instanceof Error) throw counter.reply;
    return counter.reply;
  };
  return counter;
}

function sendAt(s, when, gh, counter) {
  return send({
    root: s.repo,
    stateFile: s.stateFile,
    url: SEND_URL,
    now: () => when,
    ghJson: gh.ghJson,
    post: counter.post,
  });
}

test("with sharing off, nothing is read from gh or sent", () => inScene(async (s) => {
  seedState(s, { share: false });
  const before = readFileSync(s.stateFile, "utf8");
  const gh = fakeGh([GREEN_PR]);
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), gh, counter);
  assert.deepEqual(gh.calls, []);
  assert.deepEqual(counter.posts, []);
  assert.equal(readFileSync(s.stateFile, "utf8"), before);
}));

test("a repo with no entry sends nothing", () => inScene(async (s) => {
  seedState(s, { projects: {} });
  const gh = fakeGh([GREEN_PR]);
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), gh, counter);
  assert.deepEqual(gh.calls, []);
  assert.deepEqual(counter.posts, []);
}));

test("a repo that already sent today does not ask gh", () => inScene(async (s) => {
  seedState(s, { projects: { [s.repo]: projectEntry({ lastSendDay: "2026-11-03" }) } });
  const gh = fakeGh([GREEN_PR]);
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3, 18), gh, counter);
  assert.deepEqual(gh.calls, []);
  assert.deepEqual(counter.posts, []);
}));

test("an accepted send moves since and the day forward", () => inScene(async (s) => {
  seedState(s);
  const when = noon(3);
  const gh = fakeGh([GREEN_PR]);
  const counter = fakeCounter(OK);
  await sendAt(s, when, gh, counter);
  assert.equal(gh.calls[0].cwd, s.repo);
  assert.deepEqual(counter.posts, [{
    url: SEND_URL,
    body: {
      project: ID, kind: "game", checked: 1, caught: 0, deep: 0, merged: 1,
      from: noon(1).getTime(), to: when.getTime(),
    },
  }]);
  assert.deepEqual(projectOf(s), projectEntry({ since: when.toISOString(), lastSendDay: "2026-11-03" }));
}));

test("a project the counter already has today keeps since and marks the day", () => inScene(async (s) => {
  seedState(s);
  await sendAt(s, noon(3), fakeGh([GREEN_PR]), fakeCounter(ALREADY_SENT));
  assert.deepEqual(projectOf(s), projectEntry({ lastSendDay: "2026-11-03" }));
}));

const refusals = [
  ["a 429 for too many sends", { status: 429, error: "too many sends" }],
  ["a 429 for too many new projects", { status: 429, error: "too many new projects today" }],
  ["a 400 for a refused body", { status: 400, error: "caught and deep cannot exceed checked" }],
  ["a 413 for a large body", { status: 413, error: "body too large" }],
  ["a network error", new Error("ENOTFOUND")],
];

for (const [name, reply] of refusals) {
  test(`a send the counter refuses keeps since and records the failure: ${name}`, () =>
    inScene(async (s) => {
      seedState(s);
      const when = noon(3);
      await sendAt(s, when, fakeGh([GREEN_PR]), fakeCounter(reply));
      assert.deepEqual(projectOf(s), projectEntry({ failedAt: when.getTime() }));
    }));
}

test("a failed send is not retried for a minute, and is retried after it", () => inScene(async (s) => {
  seedState(s);
  const gh = fakeGh([GREEN_PR]);
  const counter = fakeCounter(new Error("ENOTFOUND"));
  const failedAt = noon(3, 12);
  await sendAt(s, failedAt, gh, counter);
  counter.reply = OK;
  await sendAt(s, new Date(failedAt.getTime() + 30 * 1000), gh, counter);
  assert.equal(counter.posts.length, 1);
  await sendAt(s, new Date(failedAt.getTime() + 61 * 1000), gh, counter);
  assert.equal(counter.posts.length, 2);
  assert.equal(projectOf(s).lastSendDay, "2026-11-03");
  assert.equal(projectOf(s).failedAt, null);
}));

test("a repo with no merged PRs moves since forward and asks gh once that day", () => inScene(async (s) => {
  seedState(s);
  const when = noon(3);
  const gh = fakeGh([]);
  const counter = fakeCounter(OK);
  await sendAt(s, when, gh, counter);
  await sendAt(s, noon(3, 18), gh, counter);
  assert.deepEqual(counter.posts, []);
  assert.equal(gh.calls.length, 1);
  assert.deepEqual(projectOf(s), projectEntry({ since: when.toISOString(), lastSendDay: "2026-11-03" }));
}));

test("a send whose answer was lost is not counted twice", () => inScene(async (s) => {
  seedState(s);
  const gh = fakeGh([GREEN_PR]);
  const counter = fakeCounter(new Error("The operation was aborted due to timeout"));
  const lost = noon(3, 12);
  await sendAt(s, lost, gh, counter);
  counter.reply = { status: 409, error: "this window was already counted", coveredTo: lost.getTime() };
  await sendAt(s, noon(4), gh, counter);
  assert.equal(counter.posts[1].body.from, noon(1).getTime(), "the retry resends the same start");
  assert.deepEqual(projectOf(s), projectEntry({ since: lost.toISOString() }));
  counter.reply = OK;
  await sendAt(s, noon(4, 13), gh, counter);
  assert.equal(counter.posts[2].body.from, lost.getTime(), "the next send starts where the count stops");
}));

test("a gh that fails stops the send and changes nothing", () => inScene(async (s) => {
  seedState(s);
  const before = readFileSync(s.stateFile, "utf8");
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), fakeGh(new Error("gh: command not found")), counter);
  assert.deepEqual(counter.posts, []);
  assert.equal(readFileSync(s.stateFile, "utf8"), before);
}));

test("a project call made while the send waits is kept", () => inScene(async (s) => {
  seedState(s);
  const other = join(s.repo, "..", "other");
  mkdirSync(other);
  const counter = fakeCounter(OK);
  counter.post = async (url, body) => {
    counter.posts.push({ url, body });
    setProject(s.stateFile, s.repo, "website");
    setProject(s.stateFile, other, "mobile-app");
    return OK;
  };
  await sendAt(s, noon(3), fakeGh([GREEN_PR]), counter);
  const state = JSON.parse(readFileSync(s.stateFile, "utf8"));
  assert.equal(state.projects[s.repo].kind, "website");
  assert.equal(state.projects[realpathSync(other)].kind, "mobile-app");
  assert.equal(state.projects[s.repo].lastSendDay, "2026-11-03");
}));

test("adding a repo again keeps its id and start, and sets the kind", () => inScene(async (s) => {
  setProject(s.stateFile, s.repo, "game", () => noon(1));
  const first = projectOf(s);
  setProject(s.stateFile, s.repo, "website", () => noon(2));
  const second = projectOf(s);
  assert.match(first.id, /^[0-9a-f]{32}$/);
  assert.equal(second.id, first.id);
  assert.equal(second.since, first.since);
  assert.equal(second.kind, "website");
}));

test("a damaged state file reads as sharing off with no projects, and not asked", () => inScene(async (s) => {
  writeFileSync(s.stateFile, "{ not json");
  assert.deepEqual(statusOf(s.stateFile), { asked: false, share: false, projects: [] });
}));

test("status says whether the question was answered: no file is not asked, a switch is", () => inScene(async (s) => {
  assert.deepEqual(statusOf(s.stateFile), { asked: false, share: false, projects: [] });
  setShare(s.stateFile, "off");
  assert.deepEqual(statusOf(s.stateFile), { asked: true, share: false, projects: [] });
}));

function cli(configDir, ...args) {
  return spawnSync(process.execPath, [hook, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
}

test("the CLI refuses an unknown kind with exit 1", () => inScene(async (s) => {
  const result = cli(s.configDir, "project", s.repo, "spaceship");
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /kind/);
}));

test("the CLI switches sharing on and off, and status never prints an id", () => inScene(async (s) => {
  assert.deepEqual(JSON.parse(cli(s.configDir, "share", "on").stdout), { share: true });
  assert.deepEqual(JSON.parse(cli(s.configDir, "share", "off").stdout), { share: false });
  const added = cli(s.configDir, "project", s.repo, "game");
  assert.equal(added.status, 0);
  assert.deepEqual(JSON.parse(added.stdout), { project: s.repo, kind: "game" });
  const status = cli(s.configDir, "status");
  assert.equal(status.status, 0);
  assert.equal(status.stdout.includes(projectOf(s).id), false);
  assert.deepEqual(JSON.parse(status.stdout), {
    asked: true,
    share: false,
    projects: [{ root: s.repo, kind: "game", lastSendDay: null }],
  });
}));

test("the CLI send exits 0 and prints nothing when sharing is off", () => inScene(async (s) => {
  const sent = cli(s.configDir, "send", s.repo);
  assert.equal(sent.status, 0);
  assert.equal(sent.stdout, "");
}));

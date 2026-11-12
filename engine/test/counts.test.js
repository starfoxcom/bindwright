// The opt-in review counts (helper/hooks/counts.mjs): what a repo's merged
// pull requests add up to, and what a daily send does with the counter's answer.
// Nothing here touches the network or gh: both are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORY_START,
  KINDS,
  MAX_ROUNDS,
  STALL_ROUNDS,
  countPrs,
  counterUrl,
  historyOf,
  send,
  setBackfill,
  setProject,
  setShare,
  statusOf,
} from "../../helper/hooks/counts.mjs";
import {
  KINDS as COUNTER_KINDS,
  MAX_ROUNDS_PER_SEND,
  STALL_ROUNDS as COUNTER_STALL_ROUNDS,
} from "../../counter/src/rules.js";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "helper", "hooks", "counts.mjs");
const SEND_URL = "http://127.0.0.1:8787/increment";
const ID = "0123456789abcdef0123456789abcdef";
const OK = { status: 200, error: "" };
const ALREADY_SENT = { status: 429, error: "this project already sent today" };
const DEEP = "needs-deep-review";

const comment = (body, login = "claude") => ({ author: { login }, body });
const red = comment("🔴 Blocking: the parser drops the last field");
const green = comment("🟢 LGTM");

// Local noon of a November 2026 day, so the local calendar day is the one named.
const noon = (day, hour = 12) => new Date(2026, 10, day, hour);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const SECOND = 1000;
const CAP = 500;
const GH_LIMIT = 1000;

// gh writes times in whole seconds.
const ghTime = (date) => date.toISOString().replace(".000Z", "Z");

// The time `milliseconds` after a date, as the state file stores it.
const after = (date, milliseconds) => new Date(date.getTime() + milliseconds).toISOString();

// A merged PR of the author as gh lists it, created and merged at noon of day 2 unless told.
const pr = (comments = [], labels = [], { number = 1, mergedAt = noon(2) } = {}) => ({
  number,
  createdAt: ghTime(mergedAt),
  mergedAt: ghTime(mergedAt),
  labels: labels.map((name) => ({ name })),
  comments,
});
const GREEN_PR = pr([green]);

// The counts of one PR set: merged is 1 and every other count 0 unless told otherwise.
const counted = (fields) => ({ checked: 0, caught: 0, deep: 0, merged: 1, stalled: 0, rounds: 0, ...fields });
const reds = (count) => Array.from({ length: count }, () => red);
// The deep tier's job summary opens with its own heading, then its verdict line.
const deepSummary = (verdictLine) => comment(`**Claude finished the deep review**\n\n${verdictLine}`);

const countRows = [
  ["no merged PRs counts nothing", [], counted({ merged: 0 })],
  ["a merged PR without a review counts only as merged", [pr()], counted({})],
  ["a green verdict counts as checked", [pr([green])], counted({ checked: 1 })],
  ["a red verdict later followed by green counts as caught", [pr([red, green])],
    counted({ checked: 1, caught: 1, rounds: 1 })],
  ["the last verdict line of a comment decides", [pr([comment("🔴 Blocking\n🟢 LGTM")])],
    counted({ checked: 1 })],
  ["a list item with a glyph is not a verdict", [pr([comment("- 🔴 Blocking: nit\n🟢 LGTM")])],
    counted({ checked: 1 })],
  ["numbered list items alone give no verdict", [pr([comment("1. 🔴 Blocking\n2. 🟢 LGTM")])],
    counted({})],
  ["an escalation request does not count", [pr([comment("@claude review this PR: 🔴 Blocking before")])],
    counted({})],
  ["a comment from another author does not count", [pr([comment("🔴 Blocking", "someone")])],
    counted({})],
  ["the claude[bot] login counts", [pr([comment("🟢 LGTM", "claude[bot]")])], counted({ checked: 1 })],
  ["a verdict without its glyph does not count", [pr([comment("LGTM")])], counted({})],
  ["a verdict in the middle of a sentence does not count", [pr([comment("Earlier I wrote 🟢 LGTM")])],
    counted({})],
  ["a Verdict label before the glyph counts", [pr([comment("**Verdict: 🔴 Blocking — reason.**")])],
    counted({ checked: 1, caught: 1, rounds: 1 })],
  ["a Verdict label with its colon bolded counts", [pr([comment("**Verdict:** 🟢 LGTM")])],
    counted({ checked: 1 })],
  ["Approved counts as the green word", [pr([comment("🟢 **Approved.**")])], counted({ checked: 1 })],
  ["a finding heading with a glyph is not a verdict", [pr([comment("### 🔴 Finding — x")])],
    counted({})],
  ["an invariant heading with a glyph later on is not a verdict",
    [pr([comment("### Invariant 2 — stale entries — 🔴 REAL GAP")])], counted({})],
  ["a deep label on a checked PR counts as deep", [pr([green], [DEEP])],
    counted({ checked: 1, deep: 1 })],
  ["a red deep review counts as caught and deep", [pr([red], [DEEP])],
    counted({ checked: 1, caught: 1, deep: 1, rounds: 1 })],
  ["a deep label without a verdict does not count", [pr([], [DEEP])], counted({})],
  ["a red routine round with a green deep summary is one red round", [pr([red, deepSummary("🟢 LGTM")])],
    counted({ checked: 1, caught: 1, rounds: 1 })],
  ["a green routine round with a red deep summary is one red round",
    [pr([green, deepSummary("🔴 Blocking: the parser drops the last field")], [DEEP])],
    counted({ checked: 1, caught: 1, deep: 1, rounds: 1 })],
  ["a deep review posted as a plain comment joins its push's round",
    [pr([red, comment("## Deep review\n\nThe parser drops the last field.\n\n🔴 Blocking — parser")])],
    counted({ checked: 1, caught: 1, rounds: 1 })],
  ["a deep summary with no routine before it opens a round",
    [pr([deepSummary("🔴 Blocking: nit"), green])],
    counted({ checked: 1, caught: 1, rounds: 1 })],
  ["a green routine round with a green deep summary has no red round",
    [pr([green, deepSummary("🟢 LGTM")])], counted({ checked: 1 })],
  ["two red rounds then green is caught, not stalled", [pr([...reds(2), green])],
    counted({ checked: 1, caught: 1, rounds: 2 })],
  ["three red rounds then green is stalled", [pr([...reds(3), green])],
    counted({ checked: 1, caught: 1, stalled: 1, rounds: 3 })],
  ["error and request comments open no round",
    [pr([red, comment("**Claude encountered an error** while reviewing"), comment("@claude review this PR")])],
    counted({ checked: 1, caught: 1, rounds: 1 })],
  ["red rounds add up across PRs",
    [pr([red, green], [], { number: 1 }), pr([...reds(2), green], [], { number: 2 })],
    counted({ checked: 2, caught: 2, merged: 2, rounds: 3 })],
  ["each count caps at the batch size of 500", Array.from({ length: 501 }, () => pr([green], [DEEP])),
    counted({ checked: 500, deep: 500, merged: 500 })],
  ["rounds cap at 25000, the most one send carries",
    Array.from({ length: 501 }, () => pr([...reds(50), green])),
    counted({ checked: 500, caught: 500, stalled: 500, merged: 500, rounds: 25000 })],
];

for (const [name, prs, expected] of countRows) {
  test(`counts: ${name}`, () => assert.deepEqual(countPrs(prs), expected));
}

test("the plugin offers exactly the kinds the counter accepts", () => {
  assert.deepEqual(KINDS, COUNTER_KINDS);
});

test("the plugin's stall and round limits are the counter's", () => {
  assert.equal(STALL_ROUNDS, COUNTER_STALL_ROUNDS);
  assert.equal(MAX_ROUNDS, MAX_ROUNDS_PER_SEND);
});

test("the counter URL is the live Worker unless BINDWRIGHT_COUNTER_URL names another base", () => {
  assert.equal(counterUrl(undefined), "https://bindwright-counter.starfoxcom.workers.dev/increment");
  assert.equal(counterUrl("http://127.0.0.1:8787/"), SEND_URL);
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
    nextSendAt: null,
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

// A fake gh over `prs`, which a test may add to between sends. An Error is thrown instead.
function fakeGh(prs) {
  const calls = [];
  const ghJson = async (args, cwd) => {
    calls.push({ args, cwd });
    if (prs instanceof Error) throw prs;
    return answerGh(prs, args);
  };
  return { ghJson, calls, prs };
}

// Answers a `gh pr list` call over `prs` as gh does: the `merged:` qualifier, newest created
// first unless `sort:created-asc`, at most GH_LIMIT results, and only the --json fields asked for.
function answerGh(prs, args) {
  const search = args[args.indexOf("--search") + 1];
  const fields = args[args.indexOf("--json") + 1].split(",");
  const direction = search.includes("sort:created-asc") ? 1 : -1;
  return prs
    .filter((item) => inMergedQualifier(item.mergedAt, search))
    .sort((a, b) => direction * (Date.parse(a.createdAt) - Date.parse(b.createdAt)))
    .slice(0, GH_LIMIT)
    .map((item) => Object.fromEntries(fields.map((field) => [field, item[field]])));
}

// Whether a merge time matches the `merged:` qualifier: `>=X`, or the inclusive range `A..B`.
function inMergedQualifier(mergedAt, search) {
  const at = Date.parse(mergedAt);
  const from = /merged:>=(\S+)/.exec(search);
  if (from) return at >= Date.parse(from[1]);
  const [, start, end] = /merged:(\S+?)\.\.(\S+)/.exec(search);
  return at >= Date.parse(start) && at <= Date.parse(end);
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

test("a repo left out of the counts sends nothing and stays listed", () => inScene(async (s) => {
  seedState(s, { projects: {} });
  setProject(s.stateFile, s.repo, "none");
  const gh = fakeGh([GREEN_PR]);
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), gh, counter);
  assert.deepEqual(gh.calls, []);
  assert.deepEqual(counter.posts, []);
  assert.deepEqual(statusOf(s.stateFile).projects, [{ root: s.repo, kind: null, nextSendAt: null }]);
}));

// Each row: the entry as saved, the time of one trigger, the posts the counter then gets,
// and the nextSendAt the entry holds afterwards.
const due = noon(3);
const cooldownRows = [
  ["a trigger a minute before nextSendAt sends nothing", { nextSendAt: due.toISOString() },
    new Date(due.getTime() - MINUTE), 0, due.toISOString()],
  ["a trigger at nextSendAt sends, and the next send waits 24 hours", { nextSendAt: due.toISOString() },
    due, 1, after(due, DAY)],
  ["an entry from before the cooldown sends nothing on its own local day", { lastSendDay: "2026-11-03" },
    noon(3, 18), 0, null],
  ["an entry from before the cooldown sends on the next local day", { lastSendDay: "2026-11-03" },
    noon(4), 1, after(noon(4), DAY)],
  ["a saved time that is not a date sends, as if none were saved", { nextSendAt: "soon" },
    due, 1, after(due, DAY)],
];

for (const [name, saved, when, posts, nextSendAt] of cooldownRows) {
  test(`cooldown: ${name}`, () => inScene(async (s) => {
    seedState(s, { projects: { [s.repo]: projectEntry(saved) } });
    const counter = fakeCounter(OK);
    await sendAt(s, when, fakeGh([GREEN_PR]), counter);
    assert.equal(counter.posts.length, posts);
    assert.equal(projectOf(s).nextSendAt, nextSendAt);
  }));
}

test("an accepted send moves since forward and waits 24 hours", () => inScene(async (s) => {
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
      stalled: 0, rounds: 0, from: noon(1).getTime(), to: when.getTime(),
    },
  }]);
  assert.deepEqual(projectOf(s), projectEntry({
    since: when.toISOString(), nextSendAt: after(when, DAY), lastSendDay: null,
  }));
}));

test("a send the counter already counted keeps since and waits 24 hours", () => inScene(async (s) => {
  seedState(s);
  const when = noon(3);
  await sendAt(s, when, fakeGh([GREEN_PR]), fakeCounter(ALREADY_SENT));
  assert.deepEqual(projectOf(s), projectEntry({ nextSendAt: after(when, DAY), lastSendDay: null }));
}));

test("a send carries the stalled PRs and the red rounds", () => inScene(async (s) => {
  seedState(s);
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), fakeGh([pr([...reds(3), green])]), counter);
  assert.equal(counter.posts[0].body.stalled, 1);
  assert.equal(counter.posts[0].body.rounds, 3);
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

test("a gh that fails records a failed send and posts nothing", () => inScene(async (s) => {
  seedState(s);
  const when = noon(3);
  const counter = fakeCounter({ status: 200 });
  await sendAt(s, when, fakeGh(new Error("gh: command not found")), counter);
  assert.deepEqual(projectOf(s), projectEntry({ failedAt: when.getTime() }));
  assert.equal(counter.posts.length, 0);
}));

test("a send with nothing to count clears an earlier failure", () => inScene(async (s) => {
  seedState(s);
  const when = noon(3);
  await sendAt(s, when, fakeGh(new Error("gh: command not found")), fakeCounter({ status: 200 }));
  await sendAt(s, new Date(when.getTime() + 61 * 1000), fakeGh([]), fakeCounter({ status: 200 }));
  assert.equal(projectOf(s).failedAt, null);
}));

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
  assert.equal(projectOf(s).nextSendAt, after(new Date(failedAt.getTime() + 61 * 1000), DAY));
  assert.equal(projectOf(s).failedAt, null);
}));

test("no merged PRs moves since forward and gh is not asked again within the cooldown", () => inScene(async (s) => {
  seedState(s);
  const when = noon(3);
  const gh = fakeGh([]);
  const counter = fakeCounter(OK);
  await sendAt(s, when, gh, counter);
  const asked = gh.calls.length;
  await sendAt(s, noon(3, 18), gh, counter);
  assert.deepEqual(counter.posts, []);
  assert.equal(gh.calls.length, asked);
  assert.deepEqual(projectOf(s), projectEntry({
    since: when.toISOString(), nextSendAt: after(when, DAY), lastSendDay: null,
  }));
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
  assert.deepEqual(projectOf(s), projectEntry({ since: new Date(lost.getTime() + SECOND).toISOString() }));
  gh.prs.push(pr([green], [], { mergedAt: new Date(2026, 10, 3, 12, 30) }));
  counter.reply = OK;
  await sendAt(s, noon(4, 13), gh, counter);
  assert.equal(counter.posts[2].body.from, lost.getTime() + SECOND, "the next send starts after the count stops");
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
  assert.equal(state.projects[s.repo].nextSendAt, after(noon(3), DAY));
}));

test("adding a repo again keeps its id and start, and sets the kind", () => inScene(async (s) => {
  setProject(s.stateFile, s.repo, "game");
  const first = projectOf(s);
  setProject(s.stateFile, s.repo, "website");
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
    projects: [{ root: s.repo, kind: "game", nextSendAt: null }],
  });
}));

test("the CLI send exits 0 and prints nothing when sharing is off", () => inScene(async (s) => {
  const sent = cli(s.configDir, "send", s.repo);
  assert.equal(sent.status, 0);
  assert.equal(sent.stdout, "");
}));

// `count` green PRs merged a minute apart, the first at noon of the first day.
const many = (count) => Array.from({ length: count }, (_, index) =>
  pr([green], [], { number: index + 1, mergedAt: new Date(noon(1).getTime() + index * MINUTE) }));

test("a repo added counts from GitHub's first day, with backfill off", () => inScene(async (s) => {
  setProject(s.stateFile, s.repo, "game");
  assert.equal(projectOf(s).since, HISTORY_START);
  assert.equal(projectOf(s).backfill, false);
}));

test("a history of one batch goes out in one send, from GitHub's first day to now", () => inScene(async (s) => {
  setShare(s.stateFile, "on");
  setProject(s.stateFile, s.repo, "game");
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), fakeGh(many(CAP)), counter);
  assert.deepEqual(counter.posts, [{
    url: SEND_URL,
    body: {
      project: projectOf(s).id, kind: "game", checked: CAP, caught: 0, deep: 0, merged: CAP,
      stalled: 0, rounds: 0, from: Date.parse(HISTORY_START), to: noon(3).getTime(),
    },
  }]);
}));

test("backfill on: a history past one batch goes out a batch a day, oldest first", () => inScene(async (s) => {
  seedState(s, { projects: { [s.repo]: projectEntry({ since: HISTORY_START, backfill: true }) } });
  const gh = fakeGh(many(650));
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), gh, counter);
  const first = counter.posts[0].body;
  assert.ok(first.merged <= CAP);
  assert.equal(projectOf(s).since, new Date(first.to + SECOND).toISOString());
  await sendAt(s, noon(4), gh, counter);
  const second = counter.posts[1].body;
  assert.equal(second.from, first.to + SECOND);
  assert.equal(second.to, noon(4).getTime());
  assert.equal(first.merged + second.merged, 650);
}));

for (const [name, backfillOnRetry] of [["kept on", "on"], ["turned off", "off"]]) {
  test(`a batch whose answer was lost, retried with backfill ${name}, counts no PR twice`, () => inScene(async (s) => {
    seedState(s, { projects: { [s.repo]: projectEntry({ since: HISTORY_START, backfill: true }) } });
    const gh = fakeGh(many(650));
    const counter = fakeCounter(new Error("The operation was aborted due to timeout"));
    await sendAt(s, noon(3), gh, counter);
    const first = counter.posts[0].body;
    setBackfill(s.stateFile, s.repo, backfillOnRetry);
    counter.reply = { status: 409, error: "this window was already counted", coveredTo: first.to };
    await sendAt(s, noon(4), gh, counter);
    counter.reply = OK;
    await sendAt(s, noon(5), gh, counter);
    const rest = counter.posts.at(-1).body;
    assert.equal(rest.from, first.to + SECOND);
    assert.equal(first.merged + rest.merged, 650);
  }));
}

test("backfill off: a history past one batch sends only the newest batch", () => inScene(async (s) => {
  seedState(s, { projects: { [s.repo]: projectEntry({ since: HISTORY_START }) } });
  const gh = fakeGh(many(650));
  const counter = fakeCounter(OK);
  await sendAt(s, noon(3), gh, counter);
  await sendAt(s, noon(4), gh, counter);
  assert.equal(counter.posts.length, 1);
  const newest = counter.posts[0].body;
  assert.ok(newest.merged <= CAP);
  assert.equal(newest.to, noon(3).getTime());
  assert.ok(newest.from > noon(1).getTime());
}));

const historyRows = [
  ["a history of one batch is not over the batch", CAP, false],
  ["a history one PR past a batch is over it", CAP + 1, true],
];

for (const [name, count, overLimit] of historyRows) {
  test(`history: ${name}`, () => inScene(async (s) => {
    const gh = fakeGh(many(count));
    const result = await historyOf({ root: s.repo, stateFile: s.stateFile, ghJson: gh.ghJson });
    assert.deepEqual(result, { overLimit });
  }));
}

test("the CLI turns backfill on for an added repo", () => inScene(async (s) => {
  cli(s.configDir, "project", s.repo, "game");
  const result = cli(s.configDir, "backfill", s.repo, "on");
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { project: s.repo, backfill: true });
  assert.equal(projectOf(s).backfill, true);
}));

test("the CLI refuses backfill for a repo never added, and a value other than on or off", () => inScene(async (s) => {
  const unknown = cli(s.configDir, "backfill", s.repo, "on");
  assert.equal(unknown.status, 1);
  assert.match(JSON.parse(unknown.stdout).error, /no project/);
  cli(s.configDir, "project", s.repo, "game");
  const badValue = cli(s.configDir, "backfill", s.repo, "maybe");
  assert.equal(badValue.status, 1);
  assert.match(JSON.parse(badValue.stdout).error, /on or off/);
}));

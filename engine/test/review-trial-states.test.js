// The trial state builder (helper/hooks/review-trial-states.mjs): the review markers and verdicts
// of a PR's comments, which reviews make dirty or clean states, the truth and prompt each state
// carries, how a count is picked, and the CLI's answer when gh is missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLEAN_TRUTH,
  candidatesOf,
  parseArgs,
  pickStates,
  promptOf,
  readRunIdOf,
  resolveCandidate,
  reviewAsComment,
  reviewMarkerOf,
  reviewsOf,
  truthOf,
  verdictOf,
} from "../../helper/hooks/review-trial-states.mjs";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "helper");
const script = join(HELPER, "hooks", "review-trial-states.mjs");

const BLOCKING = "🔴 Blocking";
const LGTM = "🟢 LGTM";
const T1 = "2026-01-01T00:00:00Z";
const T2 = "2026-01-02T00:00:00Z";
const T3 = "2026-01-03T00:00:00Z";
const T4 = "2026-01-04T00:00:00Z";

const bot = (body, createdAt) => ({
  body, created_at: createdAt, user: { login: "claude[bot]", type: "Bot" },
});
const human = (comment) => ({ ...comment, user: { login: "someone", type: "User" } });
// As the review comments read: the marker under the title, the findings, the verdict last.
const routine = (runId, verdict, createdAt, rest = "") =>
  bot(`## Code Review\n<!-- review-run: ${runId}-1 review -->\n${rest}\n${verdict}`, createdAt);
const deep = (runId, verdict, createdAt, rest = "") =>
  bot(`## Deep review\n<!-- deep-run: ${runId}-1 review -->\n${rest}\n${verdict}`, createdAt);
const request = (runId, createdAt) =>
  bot(`@claude review this PR\n<!-- review-run: ${runId}-1 request -->`, createdAt);
const PR = {
  number: 7, title: "Fix the parser", body: "Body text.", mergeCommit: { oid: "merge-7" },
};
const IDS = { runId: "123", attempt: "2" };

const markerRows = [
  ["a routine review marker", "x\n<!-- review-run: 123-2 review -->", "routine", IDS],
  ["a deep review marker is not a routine one",
    "<!-- deep-run: 123-2 review -->", "routine", null],
  ["a deep review marker", "<!-- deep-run: 123-2 review -->", "deep", IDS],
  ["a request marker is not a review", "<!-- review-run: 123-2 request -->", "routine", null],
];

for (const [name, body, tier, expected] of markerRows) {
  test(`reviewMarkerOf: ${name}`, () => assert.deepEqual(reviewMarkerOf(body, tier), expected));
}

const verdictRows = [
  ["the red glyph is Blocking", BLOCKING, "Blocking"],
  ["the green glyph is LGTM", LGTM, "LGTM"],
  ["the last glyph line decides", "a 🟢 heading\n- a finding\n🔴 Blocking", "Blocking"],
  ["a line opening with a red glyph blocks, as the gate reads it", "- 🔴 a finding\n🟢 LGTM",
    "Blocking"],
  ["a numbered Blocking line blocks before a green last line", "1. Blocking: x\n🟢 LGTM",
    "Blocking"],
  ["a red glyph inside prose does not block", "the old 🔴 is fixed\n🟢 LGTM", "LGTM"],
  ["a comment with no glyph has no verdict", "a comment with no verdict", null],
];

for (const [name, body, expected] of verdictRows) {
  test(`verdictOf: ${name}`, () => assert.equal(verdictOf(body), expected));
}

const candidateRows = [
  ["a Blocking review that a later LGTM turned clean is dirty",
    "routine", [routine(1, BLOCKING, T1), routine(2, LGTM, T2)], [["dirty", "1"]]],
  ["a single LGTM review is clean", "routine", [routine(3, LGTM, T1)], [["clean", "3"]]],
  ["a Blocking review with no later LGTM gives nothing",
    "routine", [routine(1, BLOCKING, T1)], []],
  ["an LGTM followed by Blocking gives nothing",
    "routine", [routine(1, LGTM, T1), routine(2, BLOCKING, T2)], []],
  ["the newest dirty review comes first",
    "routine", [routine(1, BLOCKING, T1), routine(2, LGTM, T2), routine(3, BLOCKING, T3),
      routine(4, LGTM, T4)], [["dirty", "3"], ["dirty", "1"]]],
  ["a deep review is read for the deep tier",
    "deep", [request(9, "2025-12-31T00:00:00Z"), deep(1, BLOCKING, T1), deep(2, LGTM, T2)],
    [["dirty", "9"]]],
  ["the other tier's reviews are ignored",
    "routine", [deep(1, BLOCKING, T1), deep(2, LGTM, T2)], []],
  ["a human's copy of a review is ignored",
    "routine", [human(routine(1, LGTM, T1))], []],
  ["another app's copy of a review is ignored", "routine",
    [{ ...routine(1, LGTM, T1), user: { login: "other-app[bot]", type: "Bot" } }], []],
];

for (const [name, tier, comments, expected] of candidateRows) {
  test(`candidatesOf: ${name}`, () => {
    const found = candidatesOf(PR, comments, tier).map((c) => [c.kind, c.runId]);
    assert.deepEqual(found, expected);
  });
}

test("a clean state's truth is the clean sentence", () => {
  const [clean] = candidatesOf(PR, [routine(3, LGTM, T1)], "routine");
  assert.equal(clean.truth, CLEAN_TRUTH);
});

test("a dirty state's truth is the Blocking review's findings", () => {
  const comments = [routine(1, BLOCKING, T1, "- the parser drops a token"), routine(2, LGTM, T2)];
  const [dirty] = candidatesOf(PR, comments, "routine");
  assert.equal(dirty.truth, "## Code Review\n- the parser drops a token");
});

test("truthOf drops the marker lines and the verdict line", () => {
  const body = "First finding.\n<!-- review-run: 1-1 review -->\nSecond finding.\n🔴 Blocking\n";
  assert.equal(truthOf(body), "First finding.\nSecond finding.");
});

test("truthOf cuts the text to 4000 characters", () => {
  assert.equal(truthOf(`${"x".repeat(5000)}\n🔴 Blocking`).length, 4000);
});

test("a routine prompt is the PR title and its body cut to 2000 characters", () => {
  const pr = { ...PR, body: "b".repeat(3000) };
  const prompt = promptOf("routine", pr, [], { runId: "1", attempt: "1" });
  assert.equal(prompt, `Pull request #7: Fix the parser\n\n${"b".repeat(2000)}`);
});

test("a deep prompt is the newest request posted before that review", () => {
  // The routine run posts the request under its own run id, never the deep run's.
  const comments = [request(8, T1), request(9, T2), deep(1, BLOCKING, T3), request(10, T4)];
  const [dirty] = candidatesOf(PR, [...comments, deep(2, LGTM, `${T4}z`)], "deep");
  assert.equal(dirty.prompt, "@claude review this PR\n<!-- review-run: 9-1 request -->");
});

test("a deep prompt falls back to the PR text when no request came before it", () => {
  const comments = [deep(1, BLOCKING, T1), deep(2, LGTM, T2)];
  const [dirty] = candidatesOf(PR, comments, "deep");
  assert.ok(dirty.prompt.startsWith("Pull request #7: Fix the parser"));
});

// A deep run is filed under the default branch, so its commit comes from the routine run its
// request names; with no request there is no commit to read.
const runIdRows = [
  ["a routine review reads its own run", "routine", [routine(5, BLOCKING, T2)], "5"],
  ["a deep review reads the run its request names", "deep",
    [request(8, T1), deep(1, BLOCKING, T2)], "8"],
  ["a deep review with no request before it reads none", "deep",
    [deep(1, BLOCKING, T1), request(8, T2)], null],
  ["a deep review a person started by hand reads none", "deep",
    [request(8, T1), human(bot("@claude review this PR", T2)), deep(1, BLOCKING, T3)], null],
  ["a person's trigger in another letter case reads none", "deep",
    [request(8, T1), human(bot("@Claude Review this PR", T2)), deep(1, BLOCKING, T3)], null],
  ["a person's trigger in a review body reads none", "deep", [request(8, T1),
    reviewAsComment({ body: "@claude review this PR", submitted_at: T2, user: human({}).user }),
    deep(1, BLOCKING, T3)], null],
];

// resolveCandidate with its gh and git readers stubbed: one row per answer it can give.
const candidate = { pr: 7, runId: "5", mergeOid: "merge-7" };
const readers = (event, { inClone = true, base = "base-7" } = {}) => ({
  gh: async () => `${event} sha-7`,
  git: async (root, args) => (args[0] === "cat-file" ? (inClone ? "" : null) : base),
});
const resolveRows = [
  ["a pull-request run gives its head and merge base", candidate, readers("pull_request"),
    { sha: "sha-7", base: "base-7" }],
  ["no run named", { ...candidate, runId: null }, readers("pull_request"), /no request names/],
  ["a run that did not run on the PR head", candidate, readers("issue_comment"),
    /did not run on its head/],
  ["a commit missing from the clone", candidate, readers("pull_request", { inClone: false }),
    /is not in this clone/],
  ["no merge base", candidate, readers("pull_request", { base: null }), /has no merge base/],
];

for (const [name, cand, stub, expected] of resolveRows) {
  test(`resolveCandidate: ${name}`, async () => {
    const result = await resolveCandidate("root", "o/r", cand, stub);
    if (expected instanceof RegExp) assert.match(result.reason, expected);
    else assert.deepEqual(result, expected);
  });
}

for (const [name, tier, comments, expected] of runIdRows) {
  test(`readRunIdOf: ${name}`, () => {
    const [review] = reviewsOf(comments, tier);
    assert.equal(readRunIdOf(tier, comments, review), expected);
  });
}

const cand = (kind, pr) => ({
  kind, pr, runId: String(pr), mergeOid: "merge", truth: "t", prompt: "p",
});
const resolveAll = async (candidate) => ({
  sha: `sha-${candidate.pr}`, base: `base-${candidate.pr}`,
});
const summaryOf = (states) => {
  const counts = {};
  for (const state of states) counts[state.kind] = (counts[state.kind] ?? 0) + 1;
  return Object.keys(counts).sort().map((kind) => `${kind}:${counts[kind]}`).join(" ");
};

const pickRows = [
  ["a mix takes count minus one dirty and one clean",
    [cand("dirty", 1), cand("dirty", 2), cand("dirty", 3), cand("dirty", 4), cand("dirty", 5),
      cand("clean", 6), cand("clean", 7), cand("clean", 8)], 4, "clean:1 dirty:3"],
  ["a short kind is filled from the other",
    [cand("dirty", 1), cand("clean", 2), cand("clean", 3), cand("clean", 4)],
    4, "clean:3 dirty:1"],
  ["no clean states fills with dirty",
    [cand("dirty", 1), cand("dirty", 2), cand("dirty", 3), cand("dirty", 4)], 4, "dirty:4"],
  ["a count of one takes the clean state", [cand("dirty", 1), cand("clean", 2)], 1, "clean:1"],
  ["a count of one with no clean state takes a dirty one", [cand("dirty", 1)], 1, "dirty:1"],
  ["fewer candidates than the count gives what exists", [cand("dirty", 1)], 4, "dirty:1"],
];

for (const [name, candidates, count, expected] of pickRows) {
  test(`pickStates: ${name}`, async () => {
    const { states } = await pickStates(candidates, count, resolveAll);
    assert.equal(summaryOf(states), expected);
  });
}

test("pickStates gives each PR one state by default", async () => {
  const candidates = [cand("dirty", 5), cand("dirty", 5), cand("dirty", 6)];
  const { states } = await pickStates(candidates, 3, resolveAll);
  assert.deepEqual(states.map((s) => s.id), ["pr-5", "pr-6"]);
});

test("pickStates gives a second state from one PR a -2 id when allowed", async () => {
  const candidates = [cand("dirty", 5), cand("dirty", 5), cand("dirty", 6)];
  const { states } = await pickStates(candidates, 3, resolveAll, 2);
  assert.deepEqual(states.map((s) => s.id), ["pr-5", "pr-5-2", "pr-6"]);
});

test("pickStates skips a candidate whose commit cannot be used, with its reason", async () => {
  const resolve = async (candidate) => (candidate.pr === 5
    ? { reason: "commit is not in this clone" }
    : { sha: "sha-6", base: "base-6" });
  const { states, skipped } = await pickStates([cand("dirty", 5), cand("dirty", 6)], 1, resolve);
  assert.deepEqual(skipped, [{ pr: 5, reason: "commit is not in this clone" }]);
  assert.deepEqual(states, [{
    id: "pr-6", pr: 6, kind: "dirty", sha: "sha-6", base: "base-6", prompt: "p", truth: "t",
  }]);
});

const argsRows = [
  ["the defaults are routine with four states", ["/repo"],
    { root: "/repo", tier: "routine", count: 4 }],
  ["a tier and a count", ["/repo", "--tier", "deep", "--count", "2"],
    { root: "/repo", tier: "deep", count: 2 }],
  ["an unknown tier is a usage error", ["/repo", "--tier", "nightly"], { error: /usage/ }],
  ["a count below one is a usage error", ["/repo", "--count", "0"], { error: /usage/ }],
  ["a missing root is a usage error", [], { error: /usage/ }],
];

for (const [name, argv, expected] of argsRows) {
  test(`parseArgs: ${name}`, () => {
    const parsed = parseArgs(argv);
    if (expected.error) assert.match(parsed.error, expected.error);
    else assert.deepEqual(parsed, expected);
  });
}

// Runs the script with PATH emptied, so gh is not found.
function runCli(args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = "";
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

test("the CLI prints the error shape and exits 0 when gh is missing", () => {
  const temp = mkdtempSync(join(tmpdir(), "bw-trial-"));
  try {
    const result = runCli([temp, "--count", "2"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.states, []);
    assert.match(parsed.error, /gh/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

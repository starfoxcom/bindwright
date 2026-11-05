// The runner helper (plugin/hooks/runners-assess.mjs): what the hardware leaves room for,
// how a workflow's jobs and runs-on values count, what the waits of recent jobs show, and what
// to recommend. The CLI test runs the script with gh hidden, so nothing touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NO_CI_OPTIONS,
  countJobs,
  hardwareLimit,
  recommend,
  runStats,
} from "../../plugin/hooks/runners-assess.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "hooks", "runners-assess.mjs");

// A machine with room to spare on every resource, so the row's own resource sets the limit.
const machine = (overrides) => ({ cores: 100, ramGB: 100, freeDiskGB: 1000, sharedPc: false, ...overrides });

const hardwareRows = [
  ["cores set the limit", machine({ cores: 10 }), 4],
  ["cores exactly two runners past the keep-back", machine({ cores: 6 }), 2],
  ["cores one short of two runners", machine({ cores: 5 }), 1],
  ["RAM sets the limit", machine({ ramGB: 14 }), 2],
  ["RAM exactly two runners past the keep-back", machine({ ramGB: 12 }), 2],
  ["RAM one short of two runners", machine({ ramGB: 11 }), 1],
  ["free disk sets the limit", machine({ freeDiskGB: 50 }), 2],
  ["free disk exactly two runners", machine({ freeDiskGB: 40 }), 2],
  ["free disk one short of two runners", machine({ freeDiskGB: 39 }), 1],
  ["free disk is not kept back", machine({ freeDiskGB: 20 }), 1],
  ["every resource exactly one runner", { cores: 4, ramGB: 8, freeDiskGB: 20, sharedPc: false }, 1],
  ["a small machine has room for none", { cores: 1, ramGB: 3, freeDiskGB: 10, sharedPc: false }, 0],
  ["cores below the keep-back never go negative", machine({ cores: 1 }), 0],
  ["a shared PC keeps back 4 cores", machine({ cores: 8, sharedPc: true }), 2],
  ["the same machine without sharing has room for three", machine({ cores: 8 }), 3],
  ["a shared PC one core short of two runners", machine({ cores: 7, sharedPc: true }), 1],
  ["a shared PC keeps back 8 GB of RAM", machine({ ramGB: 16, sharedPc: true }), 2],
  ["a shared PC one GB of RAM short of two runners", machine({ ramGB: 15, sharedPc: true }), 1],
  ["a shared PC at its keep-back has room for none", machine({ cores: 4, ramGB: 8, sharedPc: true }), 0],
];

for (const [name, input, expected] of hardwareRows) {
  test(`hardwareLimit: ${name}`, () => assert.equal(hardwareLimit(input), expected));
}

const countRows = [
  ["an inline self-hosted runs-on counts as self-hosted",
    "jobs:\n  build:\n    runs-on: self-hosted\n    steps: []\n", { jobs: 1, selfHosted: 1 }],
  ["a hosted runs-on is a job that is not self-hosted",
    "jobs:\n  build:\n    runs-on: ubuntu-latest\n", { jobs: 1, selfHosted: 0 }],
  ["a flow array that names self-hosted counts",
    "jobs:\n  build:\n    runs-on: [self-hosted, linux]\n", { jobs: 1, selfHosted: 1 }],
  ["a multi-line flow array that names self-hosted counts",
    "jobs:\n  build:\n    runs-on: [\n      self-hosted,\n      linux\n    ]\n", { jobs: 1, selfHosted: 1 }],
  ["a block list that names self-hosted counts",
    "jobs:\n  build:\n    runs-on:\n      - ubuntu-latest\n      - self-hosted\n", { jobs: 1, selfHosted: 1 }],
  ["self-hosted in a trailing comment does not count",
    "jobs:\n  build:\n    runs-on: ubuntu-latest  # self-hosted later\n", { jobs: 1, selfHosted: 0 }],
  ["comment and blank lines are skipped",
    "# top\njobs:\n\n  # the build\n  build:\n    # runs-on: self-hosted\n\n    runs-on: ubuntu-latest\n",
    { jobs: 1, selfHosted: 0 }],
  ["nested keys under a job are not jobs",
    "jobs:\n  build:\n    runs-on: self-hosted\n    strategy:\n      matrix:\n        os: [a]\n"
      + "    steps:\n      - name: x\n",
    { jobs: 1, selfHosted: 1 }],
  ["four-space indentation counts the same",
    "jobs:\n    build:\n        runs-on: self-hosted\n    test:\n        runs-on: ubuntu-latest\n",
    { jobs: 2, selfHosted: 1 }],
  ["a top-level key after jobs ends the block",
    "jobs:\n  build:\n    runs-on: ubuntu-latest\nenv:\n  runs-on: self-hosted\n", { jobs: 1, selfHosted: 0 }],
  ["a file with no jobs block counts nothing", "name: CI\non: push\n", { jobs: 0, selfHosted: 0 }],
];

for (const [name, yaml, expected] of countRows) {
  test(`countJobs: ${name}`, () => assert.deepEqual(countJobs(yaml), expected));
}

// A run created, started and last updated at these offsets, in seconds from T0.
const T0 = Date.parse("2026-11-05T10:00:00Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const run = (created, started, updated) => ({
  createdAt: at(created),
  startedAt: at(started),
  updatedAt: at(updated),
});

const runRows = [
  ["no runs gives no waits and nothing parallel", [],
    { sampled: 0, medianWaitSeconds: null, maxParallel: 0 }],
  ["one run's wait is its median", [run(0, 30, 90)],
    { sampled: 1, medianWaitSeconds: 30, maxParallel: 1 }],
  ["an odd count takes the middle wait", [run(0, 10, 20), run(0, 30, 40), run(0, 50, 60)],
    { sampled: 3, medianWaitSeconds: 30, maxParallel: 1 }],
  ["an even count takes the rounded mean of the two middle waits",
    [run(0, 10, 100), run(0, 20, 100), run(0, 31, 100), run(0, 40, 100)],
    { sampled: 4, medianWaitSeconds: 26, maxParallel: 4 }],
  ["a run missing startedAt is skipped", [run(0, 10, 20), { createdAt: at(0), updatedAt: at(20) }],
    { sampled: 1, medianWaitSeconds: 10, maxParallel: 1 }],
  ["a run that started before it was created is skipped",
    [{ createdAt: at(50), startedAt: at(10), updatedAt: at(60) }],
    { sampled: 0, medianWaitSeconds: null, maxParallel: 0 }],
  ["runs busy at one instant are counted together", [run(0, 0, 100), run(0, 50, 150), run(0, 60, 70)],
    { sampled: 3, medianWaitSeconds: 50, maxParallel: 3 }],
  ["a run ending when another starts does not overlap it", [run(0, 0, 100), run(0, 100, 200)],
    { sampled: 2, medianWaitSeconds: 50, maxParallel: 1 }],
];

for (const [name, runs, expected] of runRows) {
  test(`runStats: ${name}`, () => assert.deepEqual(runStats(runs), expected));
}

const [one, two, three] = NO_CI_OPTIONS;
const nothing = { count: 0, runs: "nothing" };

const recommendRows = [
  ["no room for a runner gives none, limited by hardware",
    { limit: 0, jobs: 3, maxParallel: 3 }, { kind: "none", limitedBy: "hardware" }],
  ["no CI with room for one lists only the one option",
    { limit: 1, jobs: 0, maxParallel: 0 }, { kind: "options", options: [one, nothing] }],
  ["no CI with room for two drops the three-runner option",
    { limit: 2, jobs: 0, maxParallel: 0 }, { kind: "options", options: [one, two, nothing] }],
  ["no CI with room for three lists all three",
    { limit: 3, jobs: 0, maxParallel: 0 }, { kind: "options", options: [one, two, three, nothing] }],
  ["jobs run at the parallel count when the hardware has room",
    { limit: 4, jobs: 5, maxParallel: 2 }, { kind: "count", count: 2, limitedBy: "load", wanted: 2 }],
  ["no overlap seen still wants one runner",
    { limit: 4, jobs: 3, maxParallel: 0 }, { kind: "count", count: 1, limitedBy: "load", wanted: 1 }],
  ["a parallel count equal to the limit is limited by load",
    { limit: 2, jobs: 2, maxParallel: 9 }, { kind: "count", count: 2, limitedBy: "load", wanted: 2 }],
  ["a parallel count past the limit is limited by hardware",
    { limit: 2, jobs: 5, maxParallel: 5 }, { kind: "count", count: 2, limitedBy: "hardware", wanted: 5 }],
];

for (const [name, input, expected] of recommendRows) {
  test(`recommend: ${name}`, () => assert.deepEqual(recommend(input), expected));
}

// Runs the script with CLAUDE_CONFIG_DIR set and PATH emptied, so gh is not found.
function runCli(args, configDir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = "";
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

test("the CLI prints one JSON line for a two-job repo when gh is missing", () => {
  const temp = mkdtempSync(join(tmpdir(), "bw-runners-"));
  try {
    const repo = join(temp, "repo");
    const configDir = join(temp, "config");
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    mkdirSync(configDir);
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"),
      "jobs:\n  build:\n    runs-on: ubuntu-latest\n  test:\n    runs-on: ubuntu-latest\n");
    const result = runCli([repo], configDir);
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(out), ["hardware", "sharedPc", "runnersMod", "ci", "limit", "recommendation"]);
    assert.equal(out.sharedPc, false);
    assert.equal(out.runnersMod, false);
    assert.deepEqual(out.ci, {
      workflows: 1, jobs: 2, selfHosted: 0, sampled: 0, medianWaitSeconds: null, maxParallel: 0,
    });
    const expected = out.limit === 0
      ? { kind: "none", limitedBy: "hardware" }
      : { kind: "count", count: 1, limitedBy: "load", wanted: 1 };
    assert.deepEqual(out.recommendation, expected);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("the CLI with no argument prints an error and exits 1", () => {
  const result = runCli([], join(tmpdir(), "bw-runners-no-config"));
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /usage/);
});

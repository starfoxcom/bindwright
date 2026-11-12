// The releases since a repo's bound version (--releases-since, releases.js and releases.py).
// The fixture rows test both twins with a small changelog and exact results. The CLI tests run
// both engines on throwaway repos against the plugin's real CHANGELOG.md, asserting only what
// stays true as releases are added.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelog, releasesSince } from "../releases.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(engine, "..");
const PLUGIN_VERSION = readFileSync(join(plugin, "VERSION"), "utf8").trim().replace(/^v+/, "");

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- Not released yet.",
  "",
  "## [v2.10.0] — 2026-11-12",
  "",
  "Ten.",
  "",
  "### Fixed",
  "",
  "- A fix under ten.",
  "",
  "## [v2.9.0] — 2026-11-11",
  "",
  "Nine.",
  "",
  "## [v2.8.0] - 2026-11-10 — Ringed",
  "",
  "Eight.",
  "",
  "## [v1.0.0] — 2026-05-15",
  "",
  "One.",
  "",
  "## [v0.9.0]",
  "",
  "Zero point nine, no date.",
  "",
].join("\n");

const TEN = { version: "2.10.0", date: "2026-11-12", text: "Ten.\n\n### Fixed\n\n- A fix under ten." };
const NINE = { version: "2.9.0", date: "2026-11-11", text: "Nine." };
const EIGHT = { version: "2.8.0", date: "2026-11-10", text: "Eight." };
const ONE = { version: "1.0.0", date: "2026-05-15", text: "One." };
const ZERO = { version: "0.9.0", date: null, text: "Zero point nine, no date." };

const bound = (version) => JSON.stringify({ version });

// An unavailable result is compared by the fact that its reason is there, not by its wording.
function shaped(actual) {
  return "unavailable" in actual ? { ...actual, unavailable: Boolean(actual.unavailable) } : actual;
}

// Each row gives the pristine.json text, the changelog text and the plugin version to check,
// and the result both engines must give.
const row = (name, input, expected) => ({
  name, input: { changelog: CHANGELOG, to: "2.10.0", ...input }, expected,
});

const ROWS = [
  row("releases after from, up to to, newest first; from excluded, to included",
    { pristine: bound("2.8.0") }, { from: "2.8.0", to: "2.10.0", releases: [TEN, NINE] }),
  row("to is the upper edge, not the top of the changelog",
    { pristine: bound("1.0.0"), to: "2.9.0" }, { from: "1.0.0", to: "2.9.0", releases: [NINE, EIGHT] }),
  row("2.10.0 is newer than 2.9.0",
    { pristine: bound("2.9.0") }, { from: "2.9.0", to: "2.10.0", releases: [TEN] }),
  row("the same version lists nothing",
    { pristine: bound("2.9.0"), to: "2.9.0" }, { from: "2.9.0", to: "2.9.0", releases: [] }),
  row("a from newer than to lists nothing",
    { pristine: bound("2.10.0"), to: "2.9.0" }, { from: "2.10.0", to: "2.9.0", releases: [] }),
  row("the oldest release gives every later one, never Unreleased",
    { pristine: bound("0.9.0") }, { from: "0.9.0", to: "2.10.0", releases: [TEN, NINE, EIGHT, ONE] }),
  row("a leading v in the bound version is stripped",
    { pristine: bound("v2.9.0") }, { from: "2.9.0", to: "2.10.0", releases: [TEN] }),
  row("a CRLF changelog reads the same as an LF one",
    { pristine: bound("2.8.0"), changelog: CHANGELOG.replace(/\n/g, "\r\n") },
    { from: "2.8.0", to: "2.10.0", releases: [TEN, NINE] }),
  row("no pristine.json is unavailable",
    { pristine: null }, { from: null, to: "2.10.0", releases: [], unavailable: true }),
  row("a pristine.json with no version is unavailable",
    { pristine: "{}" }, { from: null, to: "2.10.0", releases: [], unavailable: true }),
  row("a pristine.json that is not JSON is unavailable",
    { pristine: "not json" }, { from: null, to: "2.10.0", releases: [], unavailable: true }),
  row("a version that is not x.y.z is unavailable and kept as written",
    { pristine: bound("2.9") }, { from: "2.9", to: "2.10.0", releases: [], unavailable: true }),
  row("a from with no heading in the changelog is unavailable",
    { pristine: bound("2.7.0") }, { from: "2.7.0", to: "2.10.0", releases: [], unavailable: true }),
  row("no changelog is unavailable",
    { pristine: bound("2.8.0"), changelog: null }, { from: "2.8.0", to: "2.10.0", releases: [], unavailable: true }),
];

test("parseChangelog reads each release's version, date and text, and skips Unreleased", () => {
  const releases = parseChangelog(CHANGELOG);
  assert.deepEqual(releases.map((release) => release.version), ["2.10.0", "2.9.0", "2.8.0", "1.0.0", "0.9.0"]);
  assert.deepEqual(releases[0], TEN);
  assert.deepEqual(releases.at(-1), ZERO);
});

for (const { name, input, expected } of ROWS) {
  test(`js: ${name}`, () => {
    assert.deepEqual(shaped(releasesSince(input.pristine, input.changelog, input.to)), expected);
  });
}

test("python: releases_since gives the same result for every row", { skip: !python && "needs Python 3.8+" }, () => {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from releases import releases_since",
    "rows = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
    "out = [releases_since(r['pristine'], r['changelog'], r['to']) for r in rows]",
    "sys.stdout.write(json.dumps(out, ensure_ascii=True, separators=(',', ':')))",
  ].join("\n");
  const done = spawnSync(python, ["-I", "-c", script, engine], {
    input: JSON.stringify(ROWS.map((r) => r.input)), encoding: "utf8",
  });
  assert.equal(done.status, 0, done.stderr);
  const got = JSON.parse(done.stdout);
  ROWS.forEach((r, i) => assert.deepEqual(shaped(got[i]), r.expected, r.name));
});

const ENGINES = [
  ["node", (repo) => spawnSync(process.execPath,
    [join(engine, "cli.js"), "--releases-since", repo], { encoding: "utf8" })],
  ["python", (repo) => spawnSync(python,
    ["-I", join(engine, "bind.py"), "--releases-since", repo], { encoding: "utf8" })],
];

// A throwaway repo whose pristine.json names `version`; with null, the repo has no .bindwright/ at all.
function repoBound(version) {
  const repo = mkdtempSync(join(tmpdir(), "releases-"));
  if (version !== null) {
    mkdirSync(join(repo, ".bindwright"), { recursive: true });
    writeFileSync(join(repo, ".bindwright", "pristine.json"), bound(version));
  }
  return repo;
}

// Each part of a version as a number, to check the order of a listing.
const parts = (version) => version.split(".").map(Number);
const compare = (a, b) => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
};

for (const [name, run] of ENGINES) {
  const skip = name === "python" && !python ? "no Python 3.8+ found" : false;
  const listed = (version) => {
    const repo = repoBound(version);
    try {
      const done = run(repo);
      return { status: done.status, result: JSON.parse(done.stdout) };
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };

  test(`${name}: lists the releases after the bound one, up to the plugin's version`, { skip }, () => {
    const { status, result } = listed("1.0.0");
    assert.equal(status, 0);
    assert.equal(result.from, "1.0.0");
    assert.equal(result.to, PLUGIN_VERSION);
    assert.equal("unavailable" in result, false);
    assert.ok(result.releases.length > 1);
    const versions = result.releases.map((release) => release.version);
    for (const version of versions) {
      assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
      assert.ok(compare(version, "1.0.0") > 0 && compare(version, PLUGIN_VERSION) <= 0, version);
    }
    for (let i = 1; i < versions.length; i += 1) {
      assert.ok(compare(versions[i - 1], versions[i]) > 0, `${versions[i - 1]} before ${versions[i]}`);
    }
    for (const release of result.releases) {
      assert.ok(release.text.length > 0, release.version);
      assert.equal(release.text, release.text.trim(), release.version);
      assert.equal(/^## /m.test(release.text), false, release.version);
      assert.equal(release.text.includes("\r"), false, release.version);
    }
  });

  test(`${name}: the bound version equal to the plugin's lists nothing`, { skip }, () => {
    const { status, result } = listed(PLUGIN_VERSION);
    assert.equal(status, 0);
    assert.deepEqual(result, { from: PLUGIN_VERSION, to: PLUGIN_VERSION, releases: [] });
  });

  test(`${name}: a bound version missing from the changelog is unavailable, not an error`, { skip }, () => {
    const { status, result } = listed("9.9.9");
    assert.equal(status, 0);
    assert.equal(result.from, "9.9.9");
    assert.deepEqual(result.releases, []);
    assert.equal(typeof result.unavailable, "string");
  });

  test(`${name}: a repo with no pristine.json is unavailable, not an error`, { skip }, () => {
    const { status, result } = listed(null);
    assert.equal(status, 0);
    assert.equal(result.from, null);
    assert.deepEqual(result.releases, []);
    assert.equal(typeof result.unavailable, "string");
  });
}

test("both engines print the same stdout for the same repo", { skip: !python && "needs Python 3.8+" }, () => {
  const repo = repoBound("1.0.0");
  try {
    const node = ENGINES[0][1](repo);
    const py = ENGINES[1][1](repo);
    assert.equal(node.status, 0, node.stderr);
    assert.equal(py.stdout, node.stdout, py.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// CONTRIBUTING.md § Versioning: a `### Breaking` section makes a release a major, and a patch
// holds only fixes. Releases before the rule was written are left as they shipped.
test("every release from v3.5.0 on is sized by the versioning rule", () => {
  const releases = parseChangelog(readFileSync(join(plugin, "CHANGELOG.md"), "utf8"));
  const at = (version) => version.split(".").map(Number);
  const ruled = releases.filter((release) => at(release.version)[0] > 3
    || (at(release.version)[0] === 3 && at(release.version)[1] >= 5));
  assert.ok(ruled.length > 0, "the changelog has v3.5.0");
  for (const release of ruled) {
    const previous = releases[releases.indexOf(release) + 1];
    const [major, minor] = at(release.version);
    const [lastMajor, lastMinor] = at(previous.version);
    const size = major > lastMajor ? "major" : minor > lastMinor ? "minor" : "patch";
    const sections = [...release.text.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
    const label = `v${release.version} after v${previous.version}`;
    assert.equal(sections.includes("Breaking"), size === "major", `${label}: a Breaking section means a major`);
    if (size === "patch") {
      assert.ok(sections.every((s) => s === "Fixed" || s === "Security"), `${label}: a patch holds only fixes`);
    }
  }
});

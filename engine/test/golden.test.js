// The Python twin (bind.py) must produce what the JS engine produces, byte for
// byte, and fail with the same message on the same bad answers. One Python
// run binds every case, so the test stays fast on Windows too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bind } from "../bind.js";
import { python } from "./python.js";
import { withoutGithub } from "./code-host.js";
import {
  defaults, LICENSES, CODE_RESEARCH_TOOLS, PRECOMMIT_MANAGERS, ARCHITECTURES, MERGE_STYLES, HOOK_LOCATIONS, DENY_PROFILES, TRACKERS,
  CODE_HOSTS,
} from "../model.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(engine, "..");
const cache = new Map();
const readFile = async (p) => {
  if (!cache.has(p)) cache.set(p, readFileSync(join(repo, p), "utf8"));
  return cache.get(p);
};
const coreFiles = JSON.parse(readFileSync(join(engine, "core-files.json"), "utf8"));

const clone = (x) => JSON.parse(JSON.stringify(x));

// The custom code-research tool needs its own name and URL to bind.
const CUSTOM = { name: "My Tool.v2+", url: "https://example.com/tools/my-tool?ref=a&b=1" };
const withTool = (adv, tool) => ({ ...adv, codeResearch: tool, codeResearchCustom: tool === "custom" ? CUSTOM : null });

// Every advanced choice and switch, one at a time, from each of the four presets.
function oneAtATime() {
  const choices = {
    codeResearch: Object.keys(CODE_RESEARCH_TOOLS), precommit: ["none", ...PRECOMMIT_MANAGERS], architecture: ARCHITECTURES,
    branching: ["gitflow", "trunk"], mergeStyle: MERGE_STYLES, hookLocation: HOOK_LOCATIONS, denyProfile: DENY_PROFILES,
    tracker: TRACKERS,
  };
  const switches = [
    "aiReview", "deepEscalation", "uiRule", "confidentiality", "cleanRoom", "plainWriting",
    "devIsDefault", "attributionGuard", "codeSizeCheck", "handoffFile",
  ];
  const cases = [];
  for (const team of [false, true]) {
    for (const client of [false, true]) {
      const base = defaults({ team, client });
      cases.push(base);
      for (const [key, values] of Object.entries(choices)) {
        for (const v of values) {
          if (v === base.advanced[key]) continue;
          const advanced = key === "codeResearch" ? withTool(base.advanced, v) : { ...base.advanced, [key]: v };
          cases.push({ ...clone(base), advanced });
        }
      }
      for (const key of switches) cases.push({ ...clone(base), advanced: { ...base.advanced, [key]: !base.advanced[key] } });
      for (const codeHost of ["local", "other"]) cases.push(withoutGithub(clone(base), codeHost));
      for (const license of Object.keys(LICENSES)) {
        if (license !== base.project.license) cases.push({ ...clone(base), project: { ...base.project, license } });
      }
      const named = clone(base);
      named.project = { ...named.project, name: "Ember.holm_2-x", repoUrl: "https://example.com/r", licenseHolder: "Ana Núñez 😀" };
      named.advanced.plainWriting = true;
      // U+0085 passes JavaScript's trim() but not Python's strip().
      named.advanced.shippedTextPaths = ["**/*.gd", "i18n/$&-$1.json", "docs/#public/**", "notes\u0085"];
      named.advanced.trackerProject = "My-Org9/123456";
      named.advanced.publicRoadmap = "My-Org9/road.map_1";
      named.advanced.trackerRepo = "My-Org9/tracker.repo_1";
      cases.push(named);
      // The saved answers in .bindwright/project.json: both engines escape
      // quotes, backslashes and control characters alike, and nothing else.
      const escaped = clone(base);
      escaped.project = { ...escaped.project, licenseHolder: 'A "B" \\ C\u0007\u001f\u007f ' };
      cases.push(escaped);
    }
  }
  for (const team of [false, true]) {
    cases.push(defaults({ team, client: true, isPrivate: false }), defaults({ team, client: false, isPrivate: true }));
  }
  return cases;
}

// Mixed settings from a fixed seed, so a failure always reproduces.
function seeded(count) {
  let s = 0x5eed;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const bool = () => rand() < 0.5;
  return Array.from({ length: count }, () => {
    const team = bool();
    const client = bool();
    const a = defaults({ team, client, isPrivate: bool() });
    a.project.license = pick(Object.keys(LICENSES));
    Object.assign(a.advanced, {
      aiReview: bool(), deepEscalation: bool(), uiRule: bool(), confidentiality: bool(), cleanRoom: bool(), plainWriting: bool(),
      devIsDefault: bool(), attributionGuard: bool(), codeSizeCheck: bool(), handoffFile: bool(),
      codeResearch: pick(Object.keys(CODE_RESEARCH_TOOLS)), precommit: pick(["none", ...PRECOMMIT_MANAGERS]),
      architecture: pick(ARCHITECTURES), branching: pick(["gitflow", "trunk"]), mergeStyle: pick(MERGE_STYLES),
      hookLocation: pick(HOOK_LOCATIONS), denyProfile: pick(DENY_PROFILES),
      shippedTextPaths: bool() ? null : ["src/**/*.ts", "README*"],
      tracker: pick(TRACKERS),
    });
    a.advanced.trackerProject = a.advanced.tracker === "github" && bool() ? "starfoxcom/6" : null;
    a.advanced.publicRoadmap = a.advanced.tracker === "github" && bool() ? "starfoxcom/roadmap" : null;
    a.advanced.trackerRepo = a.advanced.tracker === "github" && bool() ? "starfoxcom/tracker" : null;
    a.advanced = withTool(a.advanced, a.advanced.codeResearch);
    a.advanced.codeHost = pick(CODE_HOSTS);
    if (a.advanced.codeHost !== "github") withoutGithub(a, a.advanced.codeHost);
    return a;
  });
}

// Bad answers both engines must refuse with the same message.
function refused() {
  const edits = [
    () => null,
    () => [],
    (a) => { delete a.advanced; },
    (a) => { a.advanced = []; },
    (a) => { a.project = "x"; },
    (a) => { a.team = "yes"; },
    (a) => { a.private = "yes"; },
    (a) => { a.advanced.cleanRoom = 1; },
    (a) => { delete a.advanced.uiRule; },
    (a) => { a.project.name = "-leading-dash"; },
    (a) => { a.project.name = "name\n"; },
    (a) => { a.project.name = 123; },
    (a) => { a.project.repoUrl = null; },
    (a) => { a.project.license = "toString"; },
    (a) => { a.project.license = ["MIT", "x"]; },
    (a) => { a.advanced.codeResearch = "constructor"; },
    (a) => { a.advanced.codeResearch = { name: "x" }; },
    (a) => { a.advanced.codeResearch = "custom"; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = []; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, name: " lead" }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, name: "trail " }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, name: 'say "hi"' }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, name: "x".repeat(41) }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, name: "a.b" }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, name: "Go" }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, url: "http://example.com" }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, url: "https://exa mple.com" }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { ...CUSTOM, url: "https://ejemplo.com/ñ" }; },
    (a) => { a.advanced = withTool(a.advanced, "custom"); a.advanced.codeResearchCustom = { name: "x" }; },
    (a) => { a.advanced.codeResearch = "tokensave"; a.advanced.codeResearchCustom = CUSTOM; },
    (a) => { a.advanced.precommit = "npm"; },
    (a) => { a.advanced.architecture = null; },
    (a) => { a.advanced.branching = "github-flow"; },
    (a) => { a.advanced.mergeStyle = true; },
    (a) => { a.advanced.devIsDefault = "false"; },
    (a) => { a.advanced.hookLocation = 2.5; },
    (a) => { a.advanced.attributionGuard = null; },
    (a) => { a.advanced.codeSizeCheck = "on"; },
    (a) => { delete a.advanced.codeSizeCheck; },
    (a) => { a.advanced.handoffFile = 1; },
    (a) => { a.advanced.denyProfile = "paranoid"; },
    (a) => { a.advanced.shippedTextPaths = []; },
    (a) => { a.advanced.shippedTextPaths = ["﻿docs/**"]; },
    (a) => { a.advanced.shippedTextPaths = ["😀".repeat(101)]; },
    (a) => { a.advanced.tracker = "jira"; },
    (a) => { a.advanced.tracker = ["github"]; },
    (a) => { delete a.advanced.tracker; },
    (a) => { delete a.advanced.trackerProject; },
    (a) => { a.advanced.trackerProject = "owner/0"; },
    (a) => { a.advanced.trackerProject = "owner/1234567"; },
    (a) => { a.advanced.trackerProject = "-owner/6"; },
    (a) => { a.advanced.trackerProject = "owner-/6"; },
    (a) => { a.advanced.trackerProject = `${"a".repeat(40)}/6`; },
    (a) => { a.advanced.trackerProject = "owner/6\n"; },
    (a) => { a.advanced.trackerProject = "own;er/6"; },
    (a) => { a.advanced.trackerProject = { owner: "x", number: 6 }; },
    (a) => { a.advanced.trackerProject = 6; },
    (a) => { a.advanced.tracker = "file"; a.advanced.trackerProject = "owner/6"; },
    (a) => { delete a.advanced.publicRoadmap; },
    (a) => { a.advanced.publicRoadmap = "owner"; },
    (a) => { a.advanced.publicRoadmap = "owner/.."; },
    (a) => { a.advanced.publicRoadmap = "owner/road map"; },
    (a) => { a.advanced.publicRoadmap = "-owner/roadmap"; },
    (a) => { a.advanced.publicRoadmap = `owner/${"r".repeat(101)}`; },
    (a) => { a.advanced.publicRoadmap = 6; },
    (a) => { a.advanced.tracker = "file"; a.advanced.publicRoadmap = "owner/roadmap"; },
    (a) => { delete a.advanced.trackerRepo; },
    (a) => { a.advanced.trackerRepo = "owner"; },
    (a) => { a.advanced.trackerRepo = "owner/.."; },
    (a) => { a.advanced.trackerRepo = 6; },
    (a) => { a.advanced.trackerRepo = "owner/tracker"; a.advanced.publicRoadmap = "Owner/Tracker"; },
    (a) => { a.advanced.tracker = "file"; a.advanced.trackerRepo = "owner/tracker"; },
  ];
  // An edit that returns a value replaces the answers outright.
  return edits.map((edit) => { const a = defaults(); const whole = edit(a); return whole === undefined ? a : whole; });
}

// Both engines bind each answers object; a refusal comes back as its message.
async function bindResult(answers) {
  try {
    return { files: [...(await bind(clone(answers), { readFile, coreFiles, year: 2026, version: "2.0.0" })).entries()] };
  } catch (err) {
    return { error: err.message };
  }
}

// One Python run binds every case, in order: each result is { files } or { error }.
function pythonBind(cases) {
  const out = spawnSync(python, [join(engine, "bind.py"), "--batch"], {
    input: JSON.stringify(cases.map((answers) => ({ answers, year: 2026, version: "2.0.0" }))), encoding: "utf8", maxBuffer: 1 << 30,
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

// First differing file and line, so a failure names what to fix.
function firstDifference(js, py) {
  const jsKeys = js.map(([k]) => k);
  const pyKeys = py.map(([k]) => k);
  if (jsKeys.join("\n") !== pyKeys.join("\n")) return `file lists differ:\n  js: ${jsKeys.join(", ")}\n  py: ${pyKeys.join(", ")}`;
  for (let i = 0; i < js.length; i++) {
    if (js[i][1] === py[i][1]) continue;
    const a = js[i][1].split("\n");
    const b = py[i][1].split("\n");
    const line = a.findIndex((l, n) => l !== b[n]);
    const n = line === -1 ? a.length : line;
    return `${js[i][0]} line ${n + 1}:\n  js: ${JSON.stringify(a[n])}\n  py: ${JSON.stringify(b[n])}`;
  }
  return null;
}

test("the Python engine binds exactly what the JS engine binds", { skip: !python && "needs Python 3.8+" }, async () => {
  const cases = [...oneAtATime(), ...seeded(40), ...refused()];
  const results = pythonBind(cases);
  assert.equal(results.length, cases.length);

  let bound = 0;
  for (const [i, answers] of cases.entries()) {
    const label = `case ${i}: ${JSON.stringify(answers)}`;
    const js = await bindResult(answers);
    const py = results[i];
    if (js.error || py.error) {
      assert.equal(py.error, js.error, label);
      continue;
    }
    assert.equal(firstDifference(js.files, py.files), null, label);
    bound++;
  }
  assert.ok(bound > 150, `only ${bound} cases bound; the rest were refused`);
  assert.equal(cases.length - bound, refused().length, "every refused case is one of the bad answers");
});

// Named code-host answers. Each row's answers either bind (refusal is null) or
// are refused with exactly that message, in both engines.
const refusedWith = (msg) => `Invalid answers: ${msg}`;
const withField = (codeHost, field, value) => {
  const a = withoutGithub(defaults(), codeHost);
  a.advanced[field] = value;
  return a;
};
const CODE_HOST_ROWS = [
  ["a valid local answer is accepted", withoutGithub(defaults(), "local"), null],
  ["a valid other answer is accepted", withoutGithub(defaults(), "other"), null],
  ["a github answer keeps the GitHub parts", defaults(), null],
  ["local with AI review on is refused", withField("local", "aiReview", true),
    refusedWith('codeHost "local" has no GitHub Actions: aiReview must be false')],
  ["local with deep escalation on is refused", withField("local", "deepEscalation", true),
    refusedWith('codeHost "local" has no GitHub Actions: deepEscalation must be false')],
  ["local with the github tracker is refused", withField("local", "tracker", "github"),
    refusedWith('codeHost "local" keeps the work state in files: tracker must be "file"')],
  ["local with a project board is refused", withField("local", "trackerProject", "owner/6"),
    refusedWith('codeHost "local" has no GitHub Projects board: trackerProject must be null')],
  ["local with a tracker repo is refused", withField("local", "trackerRepo", "owner/tracker"),
    refusedWith('codeHost "local" has no GitHub issues repo: trackerRepo must be null')],
  ["other with a public roadmap is refused", withField("other", "publicRoadmap", "owner/roadmap"),
    refusedWith('codeHost "other" has no GitHub public roadmap: publicRoadmap must be null')],
  ["other with a project board is refused", withField("other", "trackerProject", "owner/6"),
    refusedWith('codeHost "other" has no GitHub Projects board: trackerProject must be null')],
  ["an unknown code host is refused", withField("github", "codeHost", "gitlab"),
    refusedWith('unknown code host "gitlab"')],
  ["a code host left out is refused", (() => { const a = defaults(); delete a.advanced.codeHost; return a; })(),
    refusedWith('unknown code host "undefined"')],
];

test("code-host answers: both engines accept or refuse each named row the same way", { skip: !python && "needs Python 3.8+" }, async () => {
  const results = pythonBind(CODE_HOST_ROWS.map(([, answers]) => answers));
  for (const [i, [name, answers, refusal]] of CODE_HOST_ROWS.entries()) {
    const js = await bindResult(answers);
    assert.equal(js.error ?? null, refusal, `${name} (js)`);
    assert.equal(results[i].error ?? null, refusal, `${name} (py)`);
    if (refusal === null) assert.equal(firstDifference(js.files, results[i].files), null, name);
  }
});

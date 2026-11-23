// The pre-screen check that lists a PR's unedited template files: it renders
// the setup with the wheel the head pins and the base's answers, lists only the
// changed files equal to that render, and lists nothing, with its reason, when
// the pin names no release or the wheel does not match it.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bind } from "../bind.js";
import { defaults } from "../model.js";
import { python } from "./python.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK = join(repo, "_core", "project-template", ".github", "review-checks");
const VERSION = readFileSync(join(repo, "VERSION"), "utf8").trim().replace(/^v+/, "");
const RELEASES = "https://github.com/starfoxcom/bindwright/releases/download";
const URL = `${RELEASES}/v${VERSION}/bindwright-${VERSION}-py3-none-any.whl`;
const ANSWERS = defaults({ team: true });
const UNEDITED = ".claude/rules/git.md";
const EDITED = ".claude/rules/testing.md";

// No hooks: a hooks folder set for this computer would run on every test commit.
const NO_HOOKS = mkdtempSync(join(tmpdir(), "template-hooks-"));
after(() => rmSync(NO_HOOKS, { recursive: true, force: true }));
const git = (cwd, ...args) => {
  const config = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", `core.hooksPath=${NO_HOOKS}`];
  const r = spawnSync("git", [...config, ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

// A wheel laid out as the release's: the engine, the templates and VERSION under bindwright/.
function buildWheel(folder) {
  const wheel = join(folder, "helper.whl");
  const pack = [
    "import os, sys, zipfile",
    "src, out = sys.argv[1], sys.argv[2]",
    "with zipfile.ZipFile(out, 'w') as z:",
    "    z.write(os.path.join(src, 'VERSION'), 'bindwright/VERSION')",
    "    for top in ('engine', '_core'):",
    "        for d, _, names in os.walk(os.path.join(src, top)):",
    "            for n in names:",
    "                p = os.path.join(d, n)",
    "                parts = os.path.relpath(p, src).split(os.sep)",
    "                if not {'test', 'tests', 'types', 'node_modules'} & set(parts):",
    "                    z.write(p, 'bindwright/' + os.path.relpath(p, src).replace(os.sep, '/'))",
  ].join("\n");
  const r = spawnSync(python, ["-c", pack, repo, wheel], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return wheel;
}

// A PR's merge commit: the base holds the answers, the head changes two rendered
// files (one left as rendered, one edited) and pins the wheel.
let rendering;
function render() {
  const readFile = async (p) => readFileSync(join(repo, p), "utf8");
  const coreFiles = JSON.parse(readFileSync(join(repo, "engine", "core-files.json"), "utf8"));
  rendering ??= bind(ANSWERS, { readFile, coreFiles, year: 2026, version: VERSION });
  return rendering;
}

async function pullRequest(folder, pin, { basePin, baseVersion = VERSION } = {}) {
  const rendered = await render();
  const root = join(folder, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  put(root, ".bindwright/project.json", JSON.stringify(ANSWERS));
  put(root, ".bindwright/pristine.json", JSON.stringify({ version: baseVersion, year: 2026, files: {} }));
  put(root, "README.md", "base\n");
  if (basePin) put(root, ".bindwright/helper.json", JSON.stringify({ python: basePin }));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "pr");
  put(root, UNEDITED, rendered.get(UNEDITED).replace(/\n/g, "\r\n"));
  put(root, EDITED, rendered.get(EDITED) + "\nA line of the project's own.\n");
  put(root, ".bindwright/helper.json", JSON.stringify({ python: pin }));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "update");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--no-ff", "pr", "-m", "merge");
  put(folder, "files.txt", [UNEDITED, EDITED, ".bindwright/helper.json"].join("\n") + "\n");
  return root;
}

function runCheck(root, folder, wheel) {
  const script = [
    "import sys",
    "sys.path.insert(0, sys.argv[1])",
    "import bindwright_templates as check",
    "check.download = lambda url: open(sys.argv[3], 'rb').read()",
    "sys.exit(check.main([sys.argv[2]]))",
  ].join("\n");
  // -B: importing the check from the template folder must leave no bytecode cache there.
  const args = ["-B", "-c", script, CHECK, join(folder, "files.txt"), wheel];
  const r = spawnSync(python, args, { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const CASES = [
  {
    name: "a pinned release lists only the unedited file",
    pin: (sum) => ({ url: URL, sha256: sum }),
    listed: [UNEDITED],
  },
  {
    name: "a pin outside the release downloads lists nothing",
    pin: (sum) => ({ url: URL.replace("starfoxcom", "someone"), sha256: sum }),
    reason: "names no Bindwright release wheel",
  },
  {
    name: "a wheel that does not match its pin lists nothing",
    pin: () => ({ url: URL, sha256: "0".repeat(64) }),
    reason: "does not match the SHA-256",
  },
  {
    name: "a pin older than the base's lists nothing",
    pin: (sum) => ({ url: URL, sha256: sum }),
    basePin: { url: `${RELEASES}/v999.0.0/bindwright-999.0.0-py3-none-any.whl`, sha256: "0".repeat(64) },
    reason: `the head pins Bindwright ${VERSION}, older than the base's 999.0.0`,
  },
  {
    name: "a pin older than the base's record lists nothing when the base has no pin",
    pin: (sum) => ({ url: URL, sha256: sum }),
    baseVersion: "999.0.0",
    reason: `the head pins Bindwright ${VERSION}, older than the base's 999.0.0`,
  },
];

// One wheel for every row: packing the templates is the slow part.
let shared;
function sharedWheel() {
  if (!shared) {
    const folder = mkdtempSync(join(tmpdir(), "template-wheel-"));
    const wheel = buildWheel(folder);
    shared = { folder, wheel, sum: createHash("sha256").update(readFileSync(wheel)).digest("hex") };
  }
  return shared;
}
after(() => shared && rmSync(shared.folder, { recursive: true, force: true }));

for (const row of CASES) {
  test(`template check: ${row.name}`, { skip: !python && "needs Python 3.8+" }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "template-check-"));
    try {
      const { wheel, sum } = sharedWheel();
      const root = await pullRequest(folder, row.pin(sum), row);
      const out = runCheck(root, folder, wheel);
      const listed = out.split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
      assert.deepEqual(listed, row.listed ?? [], out);
      if (row.reason) assert.match(out, new RegExp(row.reason), out);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
}

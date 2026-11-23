// The pre-screen check that lists a PR's unedited template files: it renders
// the setup with the release the head's record names and the base's answers,
// lists only the changed files equal to that render, and lists nothing, with
// its reason, when the record names no release, the release is older than the
// base's, or the download fails.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function pullRequest(folder, { headVersion = VERSION, baseVersion = VERSION } = {}) {
  const rendered = await render();
  const root = join(folder, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  put(root, ".bindwright/project.json", JSON.stringify(ANSWERS));
  put(root, ".bindwright/pristine.json", JSON.stringify({ version: baseVersion, year: 2026, files: {} }));
  put(root, "README.md", "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "pr");
  put(root, UNEDITED, rendered.get(UNEDITED).replace(/\n/g, "\r\n"));
  put(root, EDITED, rendered.get(EDITED) + "\nA line of the project's own.\n");
  put(root, ".bindwright/pristine.json", JSON.stringify({ version: headVersion, year: 2026, files: {} }));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "update");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--no-ff", "pr", "-m", "merge");
  put(folder, "files.txt", [UNEDITED, EDITED, ".bindwright/pristine.json"].join("\n") + "\n");
  return root;
}

// The download is swapped for the local wheel, and refuses any URL but the release's own.
function runCheck(root, folder, wheel) {
  const script = [
    "import sys",
    "sys.path.insert(0, sys.argv[1])",
    "import bindwright_templates as check",
    "def download(url):",
    "    if url != sys.argv[4]:",
    "        raise OSError('asked for ' + url)",
    "    return open(sys.argv[3], 'rb').read()",
    "check.download = download",
    "sys.exit(check.main([sys.argv[2]]))",
  ].join("\n");
  // -B: importing the check from the template folder must leave no bytecode cache there.
  const args = ["-B", "-c", script, CHECK, join(folder, "files.txt"), wheel, URL];
  const r = spawnSync(python, args, { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const CASES = [
  {
    name: "the recorded release lists only the unedited file",
    listed: [UNEDITED],
  },
  {
    name: "a head record naming no release lists nothing",
    headVersion: "dev",
    reason: "the head's .bindwright/pristine.json records no Bindwright release",
  },
  {
    name: "a failed download lists nothing",
    missingWheel: true,
    reason: "the wheel download failed",
  },
  {
    name: "a release older than the base's record lists nothing",
    baseVersion: "999.0.0",
    reason: `the head records Bindwright ${VERSION}, older than the base's 999.0.0`,
  },
];

// One wheel for every row: packing the templates is the slow part.
let shared;
function sharedWheel() {
  if (!shared) {
    const folder = mkdtempSync(join(tmpdir(), "template-wheel-"));
    shared = { folder, wheel: buildWheel(folder) };
  }
  return shared;
}
after(() => shared && rmSync(shared.folder, { recursive: true, force: true }));

for (const row of CASES) {
  test(`template check: ${row.name}`, { skip: !python && "needs Python 3.8+" }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "template-check-"));
    try {
      const { wheel } = sharedWheel();
      const root = await pullRequest(folder, row);
      const out = runCheck(root, folder, row.missingWheel ? join(folder, "missing.whl") : wheel);
      const listed = out.split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
      assert.deepEqual(listed, row.listed ?? [], out);
      if (row.reason) assert.ok(out.includes(row.reason), out);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
}

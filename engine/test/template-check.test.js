// The pre-screen check that lists a PR's unedited template files: it renders
// the setup with the release the head's record names and the base's answers,
// lists only the changed files equal to that render, and lists nothing, with
// its reason, when the record names no release, the release is older than the
// base's, the download fails, or the wheel does not match the hash the base's
// helper pin records, which a PR cannot change.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bind } from "../bind.js";
import { defaults } from "../model.js";
import { python } from "./python.js";
import "./quiet-git.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK = join(repo, "_core", "project-template", ".github", "review-checks");
const VERSION = readFileSync(join(repo, "VERSION"), "utf8").trim().replace(/^v+/, "");
const RELEASES = "https://github.com/starfoxcom/bindwright/releases/download";
const URL = `${RELEASES}/v${VERSION}/bindwright-${VERSION}-py3-none-any.whl`;
const ANSWERS = defaults({ team: true });
const UNEDITED = ".claude/rules/git.md";
const EDITED = ".claude/rules/testing.md";

const git = (cwd, ...args) => {
  // autocrlf off: the line-ending rows need each file committed byte for byte.
  const config = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false"];
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
// files (one left as rendered, one edited) and pins the wheel. `baseEnding` gives the
// base an older copy of the unedited file; `headEnding` sets the head copy's line endings.
let rendering;
function render() {
  const readFile = async (p) => readFileSync(join(repo, p), "utf8");
  const coreFiles = JSON.parse(readFileSync(join(repo, "engine", "core-files.json"), "utf8"));
  rendering ??= bind(ANSWERS, { readFile, coreFiles, year: 2026, version: VERSION });
  return rendering;
}

// A helper pin as setup writes it; `null` leaves the file out.
const putPin = (root, pin) => {
  if (!pin) return;
  put(root, ".bindwright/helper.json", JSON.stringify({ version: pin.version, python: { sha256: pin.sha256 } }));
};

async function pullRequest(folder, digest, row) {
  const { headVersion = VERSION, baseVersion = VERSION, headEnding = "lf", baseEnding = null } = row;
  const ending = (text, kind) =>
    kind === "crlf" ? text.replace(/\r?\n/g, "\r\n") : kind === "mixed" ? text.replace("\n", "\r\n") : text;
  const pin = { version: VERSION, sha256: digest };
  const { basePin = pin, headPin = basePin } = row;
  const rendered = await render();
  const root = join(folder, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  put(root, ".bindwright/project.json", JSON.stringify(ANSWERS));
  put(root, ".bindwright/pristine.json", JSON.stringify({ version: baseVersion, year: 2026, files: {} }));
  putPin(root, basePin);
  put(root, "README.md", "base\n");
  if (baseEnding) put(root, UNEDITED, ending(rendered.get(UNEDITED) + "An older line.\n", baseEnding));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "pr");
  put(root, UNEDITED, ending(rendered.get(UNEDITED), headEnding));
  put(root, EDITED, rendered.get(EDITED) + "\nA line of the project's own.\n");
  put(root, ".bindwright/pristine.json", JSON.stringify({ version: headVersion, year: 2026, files: {} }));
  putPin(root, headPin);
  git(root, "add", "-A");
  if (row.headLink) {
    // A symbolic link whose target string is the render: git shows the target as its text.
    const blob = git(root, "hash-object", "-w", UNEDITED);
    git(root, "update-index", "--cacheinfo", `120000,${blob},${UNEDITED}`);
  }
  git(root, "commit", "-q", "-m", "update");
  // The merge commit is built from objects alone, so no checkout ever writes a link to disk:
  // a link whose target is a whole file is past what a filesystem allows. `main` has not
  // moved, so the merged tree is the PR's own.
  const merge = git(root, "commit-tree", "pr^{tree}", "-p", "main", "-p", "pr", "-m", "merge");
  git(root, "update-ref", "--no-deref", "HEAD", merge);
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
    name: "a copy in the CRLF endings the base already used is listed",
    baseEnding: "crlf",
    headEnding: "crlf",
    listed: [UNEDITED],
  },
  {
    name: "a PR that only adds carriage returns lists nothing",
    baseEnding: "lf",
    headEnding: "crlf",
  },
  {
    name: "a base copy with one CRLF line does not license a CRLF head",
    baseEnding: "mixed",
    headEnding: "crlf",
  },
  {
    name: "a symbolic link whose target string is the render lists nothing",
    headLink: true,
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
  {
    name: "a wheel that does not match the pin lists nothing",
    basePin: { version: VERSION, sha256: "0".repeat(64) },
    reason: "the downloaded wheel does not match the hash in .bindwright/helper.json",
  },
  {
    name: "a base with no pin lists nothing",
    basePin: null,
    reason: "the base has no .bindwright/helper.json",
  },
  {
    name: "the base's pin wins over the head's",
    headPin: { version: VERSION, sha256: "0".repeat(64) },
    listed: [UNEDITED],
  },
  {
    name: "a PR that moves the release lists nothing, whatever its own pin says",
    baseVersion: "0.1.0",
    basePin: { version: "0.1.0", sha256: "0".repeat(64) },
    headPin: "real",
    reason: `the base's .bindwright/helper.json records no wheel hash for Bindwright ${VERSION}`,
  },
];

// One wheel for every row: packing the templates is the slow part.
let shared;
function sharedWheel() {
  if (!shared) {
    const folder = mkdtempSync(join(tmpdir(), "template-wheel-"));
    const wheel = buildWheel(folder);
    shared = { folder, wheel, digest: createHash("sha256").update(readFileSync(wheel)).digest("hex") };
  }
  return shared;
}
after(() => shared && rmSync(shared.folder, { recursive: true, force: true }));

for (const row of CASES) {
  test(`template check: ${row.name}`, { skip: !python && "needs Python 3.8+" }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "template-check-"));
    try {
      const { wheel, digest } = sharedWheel();
      const headPin = row.headPin === "real" ? { version: VERSION, sha256: digest } : row.headPin;
      const root = await pullRequest(folder, digest, { ...row, headPin });
      const out = runCheck(root, folder, row.missingWheel ? join(folder, "missing.whl") : wheel);
      const listed = out.split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
      assert.deepEqual(listed, row.listed ?? [], out);
      if (row.reason) assert.ok(out.includes(row.reason), out);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
}

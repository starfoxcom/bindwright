// engine/authored.py counts the lines a person wrote by hand, from git history.
// Every case builds a throwaway git repo in a temp folder, never a real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = !python && "needs Python 3.8+";
const ALICE = "alice@x.com";
const BOB = "bob@y.com";

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "bw-authored-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function git(dir, args, env = {}) {
  const r = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// A repo with the given commits, oldest first. `write` maps paths to text,
// `remove` lists paths to delete, `date` is the author and committer date.
function makeRepo(commits) {
  const dir = mkdtempSync(join(tmpdir(), "bw-authored-repo-"));
  git(dir, ["init", "-q"]);
  const hashes = commits.map(({ email, date, write = {}, remove = [] }) => {
    for (const [path, text] of Object.entries(write)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    for (const path of remove) rmSync(join(dir, path));
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "work"], {
      GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date,
    });
    return git(dir, ["rev-parse", "HEAD"]).trim();
  });
  return { dir, hashes };
}

// n lines of text, so the numstat count is exactly n.
const lines = (n, tag = "x") => Array.from({ length: n }, (_, i) => `line ${i} ${tag}`).join("\n") + "\n";

function authored(args) {
  const r = spawnSync(python, [join(engine, "authored.py"), ...args], { encoding: "utf8" });
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}

const language = (out, name) => out.languages.find((l) => l.language === name);

test("only the given email's lines count, in any letter case", { skip }, () => withTemp(() => {
  const { dir } = makeRepo([
    { email: ALICE, date: "2024-01-10T12:00:00Z", write: { "a.py": lines(10) } },
    { email: BOB, date: "2024-01-11T12:00:00Z", write: { "b.py": lines(50) } },
  ]);
  for (const email of [ALICE, "ALICE@x.com"]) {
    const r = authored(["--before", "2024-06-01", "--email", email, dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.commits, 1);
    assert.equal(language(r.out, "Python").lines, 10);
    assert.deepEqual(language(r.out, "Python").files.map((f) => f.path), ["a.py"]);
  }
}));

test("commits on or after the cutoff are ignored", { skip }, () => withTemp(() => {
  const { dir } = makeRepo([
    { email: ALICE, date: "2024-05-31T23:00:00Z", write: { "a.py": lines(10) } },
    { email: ALICE, date: "2024-06-01T09:00:00Z", write: { "late.py": lines(100) } },
  ]);
  const r = authored(["--before", "2024-06-01", "--email", ALICE, dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.before, "2024-06-01");
  assert.equal(r.out.commits, 1);
  assert.equal(language(r.out, "Python").lines, 10);
}));

test("generated, vendored and platform scaffolding paths are ignored", { skip }, () => withTemp(() => {
  const { dir } = makeRepo([{
    email: ALICE,
    date: "2024-01-10T12:00:00Z",
    write: {
      "lib/x.g.dart": lines(200),
      "lib/x.freezed.dart": lines(200),
      "vendor/y.js": lines(300),
      "node_modules/q/index.js": lines(300),
      "third_party/z.cs": lines(300),
      "src/min.min.js": lines(300),
      "app/windows/runner/main.cpp": lines(300),
      "ios/Runner/AppDelegate.swift": lines(300),
      "android/app/src/main/kotlin/MainActivity.kt": lines(300),
      "src/keep.js": lines(7),
    },
  }]);
  const r = authored(["--before", "2024-06-01", "--email", ALICE, dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.languages.map((l) => l.language), ["JavaScript"]);
  assert.equal(language(r.out, "JavaScript").lines, 7);
}));

test("the newest commit that still holds the file is shown by git show", { skip }, () => withTemp(() => {
  const { dir, hashes } = makeRepo([
    { email: ALICE, date: "2024-01-10T12:00:00Z", write: { "a.py": lines(10, "first") } },
    { email: ALICE, date: "2024-02-01T12:00:00Z", write: { "b.py": lines(20, "second") } },
    { email: ALICE, date: "2024-03-01T12:00:00Z", write: { "a.py": lines(15, "third") } },
    { email: ALICE, date: "2024-04-01T12:00:00Z", remove: ["a.py"] },
  ]);
  const r = authored(["--before", "2024-06-01", "--email", ALICE, dir]);
  assert.equal(r.status, 0, r.stderr);
  const files = language(r.out, "Python").files;
  // a.py: 10 lines added, then a rewrite adds 15 more.
  assert.deepEqual(files.map((f) => [f.path, f.lines]), [["a.py", 25], ["b.py", 20]]);
  const [a, b] = files;
  assert.equal(b.commit, hashes[1]);
  // a.py is deleted in the last commit, so its commit is the newest one that still holds it.
  assert.equal(a.commit, hashes[2]);
  assert.equal(b.repo, dir);
  assert.equal(git(dir, ["show", `${a.commit}:a.py`]), lines(15, "third"));
  assert.equal(git(dir, ["show", `${b.commit}:b.py`]), lines(20, "second"));
}));

test("no --email counts every author", { skip }, () => withTemp(() => {
  const { dir } = makeRepo([
    { email: ALICE, date: "2024-01-10T12:00:00Z", write: { "a.py": lines(10) } },
    { email: BOB, date: "2024-01-11T12:00:00Z", write: { "b.py": lines(50) } },
  ]);
  const r = authored(["--before", "2024-06-01", dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.commits, 2);
  assert.equal(language(r.out, "Python").lines, 60);
  assert.equal(language(r.out, "Python").repos, 1);
}));

test("no more than two files per repo while another repo has candidates", { skip }, () => withTemp(() => {
  const first = makeRepo([{
    email: ALICE,
    date: "2024-01-10T12:00:00Z",
    write: { "a1.py": lines(30), "a2.py": lines(20), "a3.py": lines(10) },
  }]);
  const second = makeRepo([{ email: ALICE, date: "2024-01-10T12:00:00Z", write: { "b1.py": lines(5) } }]);
  const r = authored(["--before", "2024-06-01", "--email", ALICE, "--top", "3", first.dir, second.dir]);
  assert.equal(r.status, 0, r.stderr);
  const py = language(r.out, "Python");
  assert.deepEqual(py.files.map((f) => f.path), ["a1.py", "a2.py", "b1.py"]);
  assert.equal(py.repos, 2);
}));

test("a missing repo path is an error with exit status 1", { skip }, () => withTemp((dir) => {
  const missing = join(dir, "nope");
  const r = authored(["--before", "2024-06-01", missing]);
  assert.equal(r.status, 1);
  assert.match(r.out.error, /nope/);
}));

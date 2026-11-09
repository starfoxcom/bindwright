// --local-exclude (exclude.js and exclude.py): the bind's files listed in the clone's
// .git/info/exclude, the block kept to one copy, and --undo removing only that block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");

// Both engines take the same flags and read the answers on standard input.
const ENGINES = [
  ["node", (args, input) => spawnSync(process.execPath, [join(engine, "cli.js"), ...args],
    { encoding: "utf8", input })],
  ["python", (args, input) => spawnSync(python, ["-I", join(engine, "bind.py"), ...args],
    { encoding: "utf8", input })],
];

// Partial answers: a local-only project with no team files.
const ANSWERS = { team: false, client: true, private: true, advanced: { localOnly: true } };

function call(run, args, answers) {
  const done = run(args, answers === undefined ? undefined : JSON.stringify(answers));
  return { status: done.status, stdout: done.stdout, result: JSON.parse(done.stdout) };
}

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout;
}

// Runs `check` in a throwaway folder in the OS temp folder, a git repo unless `initGit` is false.
function withFolder(check, { initGit = true } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "local-exclude-"));
  try {
    if (initGit) spawnSync("git", ["init", "-q", folder], { encoding: "utf8" });
    check(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const excludeOf = (repo) => join(repo, ".git", "info", "exclude");

for (const [name, run] of ENGINES) {
  const skip = name === "python" && !python ? "no Python 3.8+ found" : false;

  test(`${name}: the bind's files stay out of git status, and the team's files stay listed`, { skip }, () => {
    withFolder((repo) => {
      const planned = call(run, ["--local-exclude", repo], ANSWERS);
      assert.equal(planned.status, 0);
      assert.equal(call(run, ["--write", repo], ANSWERS).status, 0);
      const untracked = git(repo, ["status", "--porcelain", "--untracked-files=all"])
        .split("\n").filter(Boolean).map((line) => line.slice(3));
      const { shared } = planned.result;
      assert.ok(untracked.every((path) => shared.includes(path)), untracked.join(", "));
      const landed = shared.filter((path) => existsSync(join(repo, path)));
      assert.ok(landed.length > 0);
      for (const path of landed) assert.ok(untracked.includes(path), path);
      const before = readFileSync(planned.result.exclude, "utf8");
      assert.equal(call(run, ["--local-exclude", repo], ANSWERS).status, 0);
      assert.equal(readFileSync(planned.result.exclude, "utf8"), before);
    });
  });

  // The user's own lines, ending with a line break or without one, or in an encoding that is
  // not UTF-8: --undo restores every byte.
  const THEIR_LINES = [
    ["last line with a line break", Buffer.from("*.log\n")],
    ["last line without a line break", Buffer.from("*.log")],
    ["a Windows-1252 comment", Buffer.from("# configuraci\xf3n\n", "latin1")],
  ];
  for (const [label, extra] of THEIR_LINES) {
    test(`${name}: the user's exclude lines survive a write, and --undo restores them exactly (${label})`,
      { skip }, () => {
        withFolder((repo) => {
          const theirs = Buffer.concat([readFileSync(excludeOf(repo)), extra]);
          writeFileSync(excludeOf(repo), theirs);
          const { result } = call(run, ["--local-exclude", repo], ANSWERS);
          assert.equal(call(run, ["--local-exclude", repo], ANSWERS).status, 0);
          assert.equal(call(run, ["--write", repo], ANSWERS).status, 0);
          assert.ok(readFileSync(excludeOf(repo)).subarray(0, theirs.length).equals(theirs));
          assert.deepEqual(call(run, ["--local-exclude", repo, "--undo"]).result,
            { exclude: result.exclude, removed: true });
          assert.ok(readFileSync(excludeOf(repo)).equals(theirs));
          assert.deepEqual(call(run, ["--local-exclude", repo, "--undo"]).result,
            { exclude: result.exclude, removed: false });
        });
      });
  }

  test(`${name}: --undo keeps a line the user added after the block on its own line`, { skip }, () => {
    withFolder((repo) => {
      writeFileSync(excludeOf(repo), "*.log");
      assert.equal(call(run, ["--local-exclude", repo], ANSWERS).status, 0);
      writeFileSync(excludeOf(repo), `${readFileSync(excludeOf(repo), "utf8")}*.tmp\n`);
      assert.equal(call(run, ["--local-exclude", repo, "--undo"]).status, 0);
      assert.equal(readFileSync(excludeOf(repo), "utf8"), "*.log\n*.tmp\n");
    });
  });

  test(`${name}: the sessions' ROADMAP.md is listed even though the plan does not write it`, { skip }, () => {
    withFolder((repo) => {
      const done = call(run, ["--local-exclude", repo], ANSWERS);
      assert.ok(done.result.lines.includes("/ROADMAP.md"), done.result.lines.join(", "));
    });
  });

  test(`${name}: a clone with no work tree is refused and its exclude file is left alone`, { skip }, () => {
    withFolder((folder) => {
      spawnSync("git", ["init", "-q", "--bare", folder], { encoding: "utf8" });
      const exclude = join(folder, "info", "exclude");
      const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : null;
      const done = call(run, ["--local-exclude", folder], ANSWERS);
      assert.equal(done.status, 1);
      assert.deepEqual(done.result, { error: `Not a work tree: ${folder}` });
      assert.equal(existsSync(exclude) ? readFileSync(exclude, "utf8") : null, before);
    }, { initGit: false });
  });

  test(`${name}: --undo with no exclude file reports removed false and creates nothing`, { skip }, () => {
    withFolder((repo) => {
      rmSync(excludeOf(repo));
      const done = call(run, ["--local-exclude", repo, "--undo"]);
      assert.equal(done.status, 0);
      assert.deepEqual(done.result, { exclude: excludeOf(repo).replace(/\\/g, "/"), removed: false });
      assert.equal(existsSync(excludeOf(repo)), false);
    });
  });

  test(`${name}: a file git already tracks is reported as tracked`, { skip }, () => {
    withFolder((repo) => {
      writeFileSync(join(repo, "CLAUDE.md"), "team rules\n");
      git(repo, ["add", "CLAUDE.md"]);
      const done = call(run, ["--local-exclude", repo], ANSWERS);
      assert.equal(done.status, 0);
      assert.deepEqual(done.result.tracked, ["CLAUDE.md"]);
    });
  });

  test(`${name}: a folder that is not a git repo is an error, with exit status 1`, { skip }, () => {
    withFolder((folder) => {
      const done = call(run, ["--local-exclude", folder], ANSWERS);
      assert.equal(done.status, 1);
      assert.deepEqual(done.result, { error: `Not a git repository: ${folder}` });
    }, { initGit: false });
  });
}

const pythonSkip = python ? false : "no Python 3.8+ found";

test("node and python print the same JSON and write the same exclude file", { skip: pythonSkip }, () => {
  withFolder((repo) => {
    const [node, py] = ENGINES.map(([, run]) => run);
    const fromNode = call(node, ["--local-exclude", repo], ANSWERS);
    const nodeFile = readFileSync(excludeOf(repo), "utf8");
    assert.equal(call(node, ["--local-exclude", repo, "--undo"]).status, 0);
    const fromPython = call(py, ["--local-exclude", repo], ANSWERS);
    assert.equal(fromPython.stdout, fromNode.stdout);
    assert.equal(readFileSync(excludeOf(repo), "utf8"), nodeFile);
  });
});

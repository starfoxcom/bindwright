// /bindwright:remove's engine steps (remove.js and remove.py), through both engines' commands:
// --remove-plan sorts what setup wrote, --remove-files takes out what the user agreed to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo } from "./bound-repo.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = ".claude/rules/testing.md";
const HOOK = ".claude/hooks/push-guard.py";

const ENGINES = [
  ["node", [process.execPath, join(engine, "cli.js")]],
  ["python", [python, "-I", join(engine, "bind.py")]],
];

function run([command, ...args], flags, input) {
  const done = spawnSync(command, [...args, ...flags], { encoding: "utf8", input });
  return { status: done.status, result: JSON.parse(done.stdout) };
}

const plan = (cli, repo) => run(cli, ["--remove-plan", repo.at("")]);
const remove = (cli, repo, paths, state) =>
  run(cli, ["--remove-files", repo.at("")], JSON.stringify({ paths, state }));

// Each case gets its own repo, removed afterwards.
async function withRepo(change, check) {
  const repo = await makeRepo(change, "remove-");
  try {
    await check(repo);
  } finally {
    rmSync(repo.at(""), { recursive: true, force: true });
  }
}

for (const [name, cli] of ENGINES) {
  const skip = name === "python" && !python ? "no Python 3.8+ found" : false;

  test(`${name}: an untouched repo is all setup's, so every file can go`, { skip }, async () => {
    await withRepo(() => {}, (repo) => {
      const { status, result } = plan(cli, repo);
      assert.equal(status, 0);
      assert.deepEqual(result.delete, Object.keys(repo.pristine.files).sort());
      assert.deepEqual([result.edited, result.merged, result.missing, result.owned], [[], [], [], []]);
    });
  });

  test(`${name}: edited, merged, missing and owned files are sorted apart`, { skip }, async () => {
    const change = (repo) => {
      repo.write(RULE, `${repo.read(RULE)}One line of our own.\n`);
      repo.write("CLAUDE.md", `# Our project\n\n${repo.read("CLAUDE.md")}`);
      rmSync(repo.at(HOOK));
      repo.write(".bindwright/owned", ".github/workflows/\n");
      repo.write(".claude/rules/git.md", repo.read(".claude/rules/git.md").replace(/\n/g, "\r\n"));
    };
    await withRepo(change, (repo) => {
      const { result } = plan(cli, repo);
      assert.deepEqual(result.edited, [RULE]);
      assert.deepEqual(result.merged, ["CLAUDE.md"]);
      assert.deepEqual(result.missing, [HOOK]);
      assert.ok(result.owned.length > 0 && result.owned.every((p) => p.startsWith(".github/workflows/")));
      assert.ok(result.delete.includes(".claude/rules/git.md"), "line endings alone are no edit");
    });
  });

  test(`${name}: removal takes the agreed files, the emptied folders, then .bindwright`, { skip }, async () => {
    await withRepo((repo) => repo.write(RULE, `${repo.read(RULE)}Ours.\n`), (repo) => {
      const sorted = plan(cli, repo).result;
      const { status, result } = remove(cli, repo, sorted.delete, true);
      assert.equal(status, 0, JSON.stringify(result));
      assert.deepEqual(result.removed, sorted.delete);
      assert.equal(result.state, true);
      assert.ok(result.folders.includes(".claude/hooks"));
      assert.equal(existsSync(repo.at(".bindwright")), false);
      assert.equal(existsSync(repo.at(RULE)), true);
      assert.deepEqual(readdirSync(repo.at("")).sort(), [".claude", ".git"]);
    });
  });

  test(`${name}: removal without the state keeps .bindwright, and a gone file is no error`, { skip }, async () => {
    await withRepo((repo) => rmSync(repo.at(HOOK)), (repo) => {
      const { status, result } = remove(cli, repo, [HOOK, RULE], false);
      assert.equal(status, 0, JSON.stringify(result));
      assert.deepEqual(result.removed, [RULE]);
      assert.equal(existsSync(repo.at(".bindwright/pristine.json")), true);
    });
  });

  const refusals = [
    ["a path setup did not write", () => {}, ["src/main.js"], "Not a file setup wrote: src/main.js"],
    ["a folder where a file was", (repo) => {
      rmSync(repo.at(RULE));
      mkdirSync(repo.at(RULE));
    }, [RULE], `Not a plain file: ${RULE}`],
  ];
  for (const [label, change, paths, error] of refusals) {
    test(`${name}: refuses ${label} and removes nothing`, { skip }, async () => {
      await withRepo(change, (repo) => {
        assert.deepEqual(remove(cli, repo, [HOOK, ...paths], true), { status: 1, result: { error } });
        assert.equal(existsSync(repo.at(HOOK)), true);
        assert.equal(existsSync(repo.at(".bindwright")), true);
      });
    });
  }

  test(`${name}: refuses a file reached through a linked folder`, { skip }, async () => {
    const outside = mkdtempSync(join(tmpdir(), "remove-outside-"));
    const change = (repo) => {
      rmSync(repo.at(".claude/rules"), { recursive: true });
      mkdirSync(join(outside, "rules"));
      symlinkSync(join(outside, "rules"), repo.at(".claude/rules"), process.platform === "win32" ? "junction" : "dir");
    };
    try {
      await withRepo(change, (repo) => {
        const { status, result } = remove(cli, repo, [RULE], true);
        assert.equal(status, 1);
        assert.match(result.error, /symbolic link: \.claude\/rules/);
        assert.equal(existsSync(join(outside, "rules")), true);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test(`${name}: a repo that was never set up is refused`, { skip }, () => {
    const bare = mkdtempSync(join(tmpdir(), "remove-bare-"));
    try {
      const { status, result } = run(cli, ["--remove-plan", bare]);
      assert.equal(status, 1);
      assert.match(result.error, /pristine\.json is missing/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
}

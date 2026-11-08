// Removing setup's staging folders (--clean-staging, staging.js and staging.py): both
// engines remove only the two staging folders, skip what is missing, and refuse links.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENGINES = [
  ["node", (repo, flags) => spawnSync(process.execPath,
    [join(engine, "cli.js"), "--clean-staging", repo, ...flags], { encoding: "utf8" })],
  ["python", (repo, flags) => spawnSync(python,
    ["-I", join(engine, "bind.py"), "--clean-staging", repo, ...flags], { encoding: "utf8" })],
];

function run(clean, repo, flags = []) {
  const done = clean(repo, flags);
  return { status: done.status, result: JSON.parse(done.stdout) };
}

const BOTH = [".bindwright/incoming", ".bindwright/global"];

// A repo with both staging folders, the files setup keeps beside them, and one outside.
// `waiting` puts a staged copy the user has not settled in .bindwright/incoming/.
function stagedRepo({ waiting = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "staging-"));
  for (const folder of ["incoming/.claude", "global/hooks"]) {
    mkdirSync(join(repo, ".bindwright", folder), { recursive: true });
  }
  if (waiting) writeFileSync(join(repo, ".bindwright", "incoming", ".claude", "settings.json"), "{}");
  writeFileSync(join(repo, ".bindwright", "global", "hooks", "push-guard.py"), "");
  writeFileSync(join(repo, ".bindwright", "pristine.json"), "{}");
  writeFileSync(join(repo, "README.md"), "mine");
  return repo;
}

// A folder link that needs no admin rights on Windows (a junction).
function linkFolder(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

for (const [name, clean] of ENGINES) {
  const skip = name === "python" && !python ? "no Python 3.8+ found" : false;
  const at = (repo, ...parts) => join(repo, ".bindwright", ...parts);

  test(`${name}: settled staging goes, and everything else stays`, { skip }, () => {
    const repo = stagedRepo();
    try {
      assert.deepEqual(run(clean, repo), { status: 0, result: { removed: BOTH, unsettled: [] } });
      assert.deepEqual([at(repo, "incoming"), at(repo, "global")].map(existsSync), [false, false]);
      assert.equal(existsSync(at(repo, "pristine.json")), true);
      assert.equal(existsSync(join(repo, "README.md")), true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test(`${name}: a staged copy still waiting keeps .bindwright/incoming, unless discarded`, { skip }, () => {
    const repo = stagedRepo({ waiting: true });
    try {
      assert.deepEqual(run(clean, repo), {
        status: 0, result: { removed: [".bindwright/global"], unsettled: [".claude/settings.json"] },
      });
      assert.equal(existsSync(at(repo, "incoming", ".claude", "settings.json")), true);
      assert.deepEqual(run(clean, repo, ["--discard-incoming"]), {
        status: 0, result: { removed: [".bindwright/incoming"], unsettled: [] },
      });
      assert.equal(existsSync(at(repo, "incoming")), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test(`${name}: a repo root that is a link is followed to the real folder`, { skip }, () => {
    const repo = stagedRepo();
    const parent = mkdtempSync(join(tmpdir(), "staging-link-"));
    const linked = join(parent, "project");
    try {
      linkFolder(repo, linked);
      assert.deepEqual(run(clean, linked), { status: 0, result: { removed: BOTH, unsettled: [] } });
      assert.equal(existsSync(at(repo, "global")), false);
      assert.equal(existsSync(at(repo, "pristine.json")), true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test(`${name}: missing folders are skipped`, { skip }, () => {
    const repo = mkdtempSync(join(tmpdir(), "staging-"));
    try {
      assert.deepEqual(run(clean, repo), { status: 0, result: { removed: [], unsettled: [] } });
      mkdirSync(at(repo, "global"), { recursive: true });
      writeFileSync(at(repo, "project.json"), "{}");
      assert.deepEqual(run(clean, repo), { status: 0, result: { removed: [".bindwright/global"], unsettled: [] } });
      assert.equal(existsSync(at(repo, "project.json")), true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test(`${name}: a .bindwright left empty goes too, as outside a repo`, { skip }, () => {
    const repo = mkdtempSync(join(tmpdir(), "staging-"));
    try {
      mkdirSync(join(repo, ".bindwright", "global", "hooks"), { recursive: true });
      assert.deepEqual(run(clean, repo), {
        status: 0, result: { removed: [".bindwright/global", ".bindwright"], unsettled: [] },
      });
      assert.equal(existsSync(join(repo, ".bindwright")), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Each row plants its problem beside a real .bindwright/incoming, except where .bindwright
  // itself is the link.
  const refusals = [
    ["a linked staging folder", true, (repo, outside) => linkFolder(outside, join(repo, ".bindwright", "global")),
      ".bindwright/global is a link; remove it by hand"],
    ["a linked .bindwright", false, (repo, outside) => linkFolder(outside, join(repo, ".bindwright")),
      ".bindwright is a link; remove it by hand"],
    ["a file where a folder should be", true, (repo) => writeFileSync(join(repo, ".bindwright", "global"), ""),
      ".bindwright/global is not a folder; remove it by hand"],
  ];
  for (const [label, hasIncoming, plant, error] of refusals) {
    test(`${name}: refuses ${label} and removes nothing`, { skip }, () => {
      const repo = mkdtempSync(join(tmpdir(), "staging-"));
      const outside = mkdtempSync(join(tmpdir(), "staging-outside-"));
      const incoming = join(repo, ".bindwright", "incoming");
      try {
        writeFileSync(join(outside, "keep.txt"), "not setup's");
        if (hasIncoming) mkdirSync(incoming, { recursive: true });
        plant(repo, outside);
        assert.deepEqual(run(clean, repo), { status: 1, result: { error } });
        assert.equal(existsSync(join(outside, "keep.txt")), true);
        if (hasIncoming) assert.equal(existsSync(incoming), true);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
}

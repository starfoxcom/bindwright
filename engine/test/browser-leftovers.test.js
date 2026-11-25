// browser-leftovers.py (the global hook) runs on a throwaway temp folder and home folder.
// The hook is checked by what it prints at session start and what `--clean` leaves on
// disk; which profiles count as left behind is checked against a given process list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = join(repo, "_core", "global-template", "hooks", "browser-leftovers.py");
const skip = !python && "needs Python 3.8+";
const SESSION = "this-session";
const HOUR_S = 60 * 60;

function makeLayout() {
  const base = mkdtempSync(join(tmpdir(), "bw-leftovers-"));
  mkdirSync(join(base, "home"));
  return { base, temp: join(base, "tmp"), home: join(base, "home") };
}

function withLayout(fn) {
  const layout = makeLayout();
  try {
    return fn(layout);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
}

// A browser profile in <temp>/claude/<project>/<session>/scratchpad/<name>, last written
// `hoursAgo` hours ago, with the session's transcript under the project `slug`.
function profile(layout, { session = "old-session", name = "profile", hoursAgo = 2, slug = "P--demo" } = {}) {
  const folder = join(layout.temp, "claude", "c0ffee", session, "scratchpad", name);
  mkdirSync(join(folder, "Default"), { recursive: true });
  writeFileSync(join(folder, "Local State"), "{}");
  const transcript = join(layout.home, ".claude", "projects", slug, `${session}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, "");
  const seconds = Date.now() / 1000 - hoursAgo * HOUR_S;
  for (const path of [folder, join(folder, "Local State"), join(folder, "Default")]) utimesSync(path, seconds, seconds);
  return folder;
}

function env(layout) {
  return {
    ...process.env, CLAUDE_CODE_TMPDIR: layout.temp, HOME: layout.home, USERPROFILE: layout.home,
    CLAUDE_CONFIG_DIR: join(layout.home, ".claude"),
  };
}

function start(layout, source = "startup") {
  const r = spawnSync(python, ["-I", hook], {
    input: JSON.stringify({ hook_event_name: "SessionStart", source, session_id: SESSION }),
    encoding: "utf8", env: env(layout),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
}

test("session start reports only the profiles earlier sessions left behind", { skip }, () => {
  const rows = [
    ["a profile last written two hours ago, with its project", (l) => profile(l), /1 browser profile.*P--demo/],
    ["a profile written in the last hour", (l) => profile(l, { hoursAgo: 0 }), null],
    ["this session's own profile", (l) => profile(l, { session: SESSION }), null],
    ["a folder with a Default folder but no browser files", (l) => {
      mkdirSync(join(l.temp, "claude", "c0ffee", "old-session", "scratchpad", "x", "Default"), { recursive: true });
    }, null],
  ];
  for (const [name, setup, expected] of rows) {
    withLayout((layout) => {
      setup(layout);
      const note = start(layout);
      if (expected) assert.match(note, expected, name);
      else assert.equal(note, "", name);
      if (expected) assert.match(note, new RegExp(`--clean ${SESSION}\``), name);
    });
  }
});

test("the check runs once a day, and only when a session starts fresh", { skip }, () => {
  withLayout((layout) => {
    profile(layout);
    assert.equal(start(layout, "resume"), "", "a resumed session");
    assert.equal(start(layout, "compact"), "", "a compaction");
    assert.notEqual(start(layout), "", "the day's first new session");
    assert.equal(start(layout), "", "a second new session the same day");
  });
});

test("--clean deletes the folders left behind and keeps the ones in use", { skip }, () => {
  withLayout((layout) => {
    const old = profile(layout, { name: "old" });
    const fresh = profile(layout, { name: "fresh", hoursAgo: 0 });
    const r = spawnSync(python, ["-I", hook, "--clean", SESSION], { encoding: "utf8", env: env(layout) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { removed: [old], kept: [] });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  });
});

// Runs the hook's own selection on a process list given as [pid, parent pid, command line].
function leftBehind(folders, processes) {
  const driver = "import importlib.util, json, sys, time\n"
    + "spec = importlib.util.spec_from_file_location('hook', sys.argv[1])\n"
    + "hook = importlib.util.module_from_spec(spec)\n"
    + "spec.loader.exec_module(hook)\n"
    + "folders, processes = json.load(sys.stdin)\n"
    + "print(json.dumps(hook.left_behind(folders, [tuple(p) for p in processes], time.time())))\n";
  const r = spawnSync(python, ["-I", "-c", driver, hook], {
    input: JSON.stringify([folders, processes]), encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("a browser counts as left behind only once the script that started it is gone", { skip }, () => {
  withLayout((layout) => {
    const old = profile(layout, { name: "old" });
    const fresh = profile(layout, { name: "fresh", hoursAgo: 0 });
    const flag = (folder) => `msedge --headless --user-data-dir="${folder}"`;
    const rows = [
      ["a running script's browser on an old profile", [[10, 9, ""], [20, 10, flag(old)], [21, 20, flag(old)]], {}],
      ["a browser whose script is gone, on a fresh profile", [[20, 9, flag(fresh)], [21, 20, flag(fresh)]],
        { [old]: [], [fresh]: [20, 21] }],
      ["a browser on a longer path that starts with the profile's", [[20, 9, flag(`${fresh}2`)]], { [old]: [] }],
    ];
    for (const [name, processes, expected] of rows) {
      assert.deepEqual(leftBehind([old, fresh], processes), expected, name);
    }
  });
});

test("an old profile that a browser with a running parent uses is left alone", { skip }, async () => {
  const layout = makeLayout();
  const old = profile(layout);
  const browser = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${old}`]);
  try {
    await new Promise((ready) => setTimeout(ready, 500));
    assert.equal(start(layout), "");
  } finally {
    browser.kill();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

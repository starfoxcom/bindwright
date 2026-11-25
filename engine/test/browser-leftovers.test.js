// browser-leftovers.py (the global hook) runs on a throwaway temp folder and home folder.
// The hook is checked by what it prints at session start and what `--clean` leaves on
// disk; which profiles count as left behind is checked against a given process list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

// A browser profile in <temp>/<root>/<project>/<session>/scratchpad/<name>, last written
// `hoursAgo` hours ago, with the session's transcript under the project `slug`.
function profile(layout, { session = "old-session", name = "profile", hoursAgo = 2, slug = "P--demo",
  root = "claude" } = {}) {
  const folder = join(layout.temp, root, "c0ffee", session, "scratchpad", name);
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

test("a shared temp folder's claude-<user id> folder is looked in too", {
  skip: skip || (!process.getuid && "Windows has no user ids"),
}, () => {
  withLayout((layout) => {
    profile(layout, { root: `claude-${process.getuid()}` });
    assert.match(start(layout), /1 browser profile/);
  });
});

test("a temp root that is a link is never walked", {
  skip: skip || (process.platform === "win32" && "a link needs extra rights on Windows"),
}, () => {
  withLayout((layout) => {
    // The link points at a folder that holds a real-looking profile, as a home folder would.
    const target = join(layout.base, "elsewhere");
    mkdirSync(join(target, "c0ffee", "old-session", "scratchpad", "profile", "Default"), { recursive: true });
    const state = join(target, "c0ffee", "old-session", "scratchpad", "profile", "Local State");
    writeFileSync(state, "{}");
    const seconds = Date.now() / 1000 - 2 * HOUR_S;
    utimesSync(state, seconds, seconds);
    mkdirSync(layout.temp, { recursive: true });
    symlinkSync(target, join(layout.temp, "claude"), "dir");
    assert.equal(start(layout), "");
  });
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
    + "processes = None if processes is None else [tuple(p) for p in processes]\n"
    + "print(json.dumps(hook.left_behind(folders, processes, time.time())))\n";
  const r = spawnSync(python, ["-I", "-c", driver, hook], {
    input: JSON.stringify([folders, processes]), encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("a profile is picked only after an hour unwritten, with no live script's browser on it", { skip }, () => {
  withLayout((layout) => {
    const old = profile(layout, { name: "old" });
    const fresh = profile(layout, { name: "fresh", hoursAgo: 0 });
    const flag = (folder) => `msedge --headless --user-data-dir="${folder}"`;
    const script = [10, 9, "node drive.mjs"];
    const rows = [
      ["no browser", [script], { [old]: [] }],
      ["a running script's browser on the old profile", [script, [20, 10, flag(old)], [21, 20, flag(old)]], {}],
      ["the same, its path written with a closing slash", [script, [20, 10, `${flag(old)}/`]], {}],
      ["a browser whose script is gone, on the old profile", [script, [20, 9, flag(old)], [21, 20, flag(old)]],
        { [old]: [20, 21] }],
      ["a browser whose script is gone, on the fresh profile", [script, [20, 9, flag(fresh)]], { [old]: [] }],
      ["a browser on a longer path that starts with the old one's", [script, [20, 10, flag(`${old}2`)]],
        { [old]: [] }],
      ["a process list that could not be read", null, {}],
      ["a browser whose profile path is relative", [script, [30, 10, "chrome --user-data-dir=profile"]], {}],
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

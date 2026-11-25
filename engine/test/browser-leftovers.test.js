// browser-leftovers.py (the global hook) runs on a throwaway temp folder and home folder.
// The hook is checked by what it prints at session start and what `--clean` leaves on
// disk; which profiles count as left behind is checked against the lock a browser keeps in each.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

// Puts the lock Chromium keeps in a running browser's profile into each folder, as the row
// says, ages it, and runs the hook's own selection. On Windows a held lock is a `lockfile`
// opened the way Chromium opens it (others may read it but not write it); elsewhere a lock is
// a `SingletonLock` link to <host>-<pid>.
const LOCK_DRIVER = `
import ctypes, importlib.util, json, os, socket, sys, time
spec = importlib.util.spec_from_file_location("hook", sys.argv[1])
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)
cases, dead_pid = json.load(sys.stdin)
old, handles = time.time() - 7200, []
for folder, lock in cases:
    link = os.path.join(folder, "SingletonLock")
    owners = {"live": socket.gethostname(), "dead": socket.gethostname(), "elsewhere": "another-host"}
    if lock in owners:
        os.symlink("%s-%d" % (owners[lock], dead_pid if lock == "dead" else os.getpid()), link)
        os.utime(link, (old, old), follow_symlinks=False)
    elif lock == "plain":
        open(link, "w").close()
        os.utime(link, (old, old))
    elif lock in ("held", "released"):
        path = os.path.join(folder, "lockfile")
        if lock == "held":
            kernel = ctypes.WinDLL("kernel32")
            kernel.CreateFileW.restype = ctypes.c_void_p
            handles.append(kernel.CreateFileW(path, 0x40000000, 1, None, 2, 0x80, None))
        else:
            open(path, "w").close()
        os.utime(path, (old, old))
    os.utime(folder, (old, old))
print(json.dumps(hook.left_behind([folder for folder, _ in cases], time.time())))
`;

function leftBehind(cases) {
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  const r = spawnSync(python, ["-I", "-c", LOCK_DRIVER, hook], {
    input: JSON.stringify([cases, deadPid]), encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("an old profile is picked only when no running browser holds its lock", { skip }, () => {
  withLayout((layout) => {
    const rows = process.platform === "win32"
      ? [["no lock", "none", true], ["a lockfile a running browser holds", "held", false],
        ["a lockfile nothing holds", "released", true]]
      : [["no lock", "none", true], ["a lock naming a running process", "live", false],
        ["a lock naming a process that ended", "dead", true],
        ["a lock naming another computer's process", "elsewhere", false],
        ["a lock that is not a link", "plain", false]];
    const cases = rows.map(([, lock], i) => [profile(layout, { name: `p${i}` }), lock]);
    const picked = leftBehind(cases);
    rows.forEach(([name, , isPicked], i) => assert.equal(picked.includes(cases[i][0]), isPicked, name));
  });
});

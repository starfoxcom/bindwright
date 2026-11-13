// session-title.py (the global hook) runs on a throwaway folder in the OS temp dir,
// with the home folder pointing at a temp folder. Every case is checked by
// what the hook prints, the status it exits with and the files it leaves on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = join(repo, "_core", "global-template", "hooks", "session-title.py");
const skip = !python && "needs Python 3.8+";
const SESSION = "abc-123";
const DAY_MS = 24 * 60 * 60 * 1000;

// The project sits at base/repo/app, so a .git added at base/repo is one folder above it.
// The home folder is base/home.
function withLayout(fn) {
  const base = mkdtempSync(join(tmpdir(), "bw-title-"));
  const root = join(base, "repo", "app");
  mkdirSync(root, { recursive: true });
  const home = join(base, "home");
  try {
    return fn({ root, home, titles: join(home, ".bindwright", "session-titles") });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function writeProject(layout, name) {
  writeFile(join(layout.root, ".bindwright", "project.json"), JSON.stringify({ project: { name } }));
}

const purposeInTitles = (layout, text, session = SESSION) =>
  writeFile(join(layout.titles, `${session}.purpose`), text);
const purposeInRepo = (layout, text) =>
  writeFile(join(layout.root, ".bindwright", "sessions", `${SESSION}.purpose`), text);

// Sets a file's modification time to `days` days in the past.
function ageFile(path, days) {
  const seconds = (Date.now() - days * DAY_MS) / 1000;
  utimesSync(path, seconds, seconds);
}

function event(hookEventName = "SessionStart", sessionId = SESSION) {
  return { hook_event_name: hookEventName, session_id: sessionId, cwd: "/elsewhere" };
}

function runHook(layout, input) {
  const r = spawnSync(python, ["-I", hook], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: layout.root, HOME: layout.home, USERPROFILE: layout.home },
  });
  return { status: r.status, out: r.stdout };
}

const hookOutput = (out) => JSON.parse(out).hookSpecificOutput;
const titleRecord = (layout) => readFileSync(join(layout.titles, `${SESSION}.title`), "utf8");

const cases = [
  {
    name: "a project name alone titles the session with the name",
    setup: (layout) => writeProject(layout, "Demo"),
    input: event(),
    check(layout, run) {
      assert.equal(run.status, 0);
      assert.equal(hookOutput(run.out).sessionTitle, "Demo");
      assert.equal(titleRecord(layout), "Demo");
    },
  },
  {
    name: "no project name and no .git titles the session with the root's folder name",
    input: event(),
    check(layout, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "app");
      assert.equal(titleRecord(layout), "app");
    },
  },
  {
    name: "a .git folder above the root titles the session with that folder's name",
    setup: (layout) => mkdirSync(join(dirname(layout.root), ".git")),
    input: event(),
    check(layout, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "repo");
    },
  },
  {
    name: "a .git file above the root counts as a repo too",
    setup: (layout) => writeFile(join(dirname(layout.root), ".git"), "gitdir: elsewhere\n"),
    input: event(),
    check(layout, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "repo");
    },
  },
  {
    name: "the project name wins over the .git folder's name",
    setup(layout) {
      mkdirSync(join(dirname(layout.root), ".git"));
      writeProject(layout, "Demo");
    },
    input: event(),
    check(layout, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "Demo");
    },
  },
  {
    name: "a 14-word purpose with a newline keeps its first 10 words",
    setup(layout) {
      writeProject(layout, "Demo");
      purposeInTitles(layout, "one two three four five\nsix seven eight nine ten eleven twelve thirteen fourteen");
    },
    input: event(),
    check(layout, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "Demo - one two three four five six seven eight nine ten");
    },
  },
  {
    name: "a newer purpose in the repo beats an older one in the titles folder",
    setup(layout) {
      writeProject(layout, "Demo");
      ageFile(purposeInTitles(layout, "old titles focus"), 2);
      purposeInRepo(layout, "new repo focus");
    },
    input: event(),
    check(layout, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "Demo - new repo focus");
    },
  },
  {
    name: "a newer purpose in the titles folder beats an older one in the repo",
    setup(layout) {
      writeProject(layout, "Demo");
      ageFile(purposeInRepo(layout, "old repo focus"), 2);
      purposeInTitles(layout, "new titles focus");
    },
    input: event(),
    check(layout, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "Demo - new titles focus");
    },
  },
  {
    name: "SessionStart asks for the purpose at its absolute path, in forward slashes",
    setup: (layout) => writeProject(layout, "Demo"),
    input: event(),
    check(layout, run) {
      const { additionalContext } = hookOutput(run.out);
      const path = join(layout.titles, `${SESSION}.purpose`).replace(/\\/g, "/");
      assert.ok(additionalContext.includes(path), additionalContext);
      assert.match(additionalContext, /10 words or fewer/);
    },
  },
  {
    name: "UserPromptSubmit prints the title and no request for the purpose",
    setup: (layout) => writeProject(layout, "Demo"),
    input: event("UserPromptSubmit"),
    check(layout, run) {
      const output = hookOutput(run.out);
      assert.equal(output.hookEventName, "UserPromptSubmit");
      assert.equal(output.sessionTitle, "Demo");
      assert.ok(!("additionalContext" in output));
    },
  },
  {
    name: "a session id with ../ prints nothing and creates no titles folder",
    setup: (layout) => writeProject(layout, "Demo"),
    input: event("SessionStart", "../escape"),
    check(layout, run) {
      assert.equal(run.status, 0);
      assert.equal(run.out, "");
      assert.equal(existsSync(layout.titles), false);
    },
  },
  {
    name: "invalid JSON on stdin prints nothing and exits 0",
    setup: (layout) => writeProject(layout, "Demo"),
    input: "{not json",
    check(layout, run) {
      assert.equal(run.status, 0);
      assert.equal(run.out, "");
    },
  },
];

for (const row of cases) {
  test(row.name, { skip }, () => withLayout((layout) => {
    if (row.setup) row.setup(layout);
    row.check(layout, runHook(layout, row.input));
  }));
}

test("the same prompt twice prints the title once", { skip }, () => withLayout((layout) => {
  writeProject(layout, "Demo");
  assert.equal(hookOutput(runHook(layout, event("UserPromptSubmit")).out).sessionTitle, "Demo");
  assert.equal(runHook(layout, event("UserPromptSubmit")).out, "");
}));

test("SessionStart with an unchanged title prints the request and no title", { skip }, () => withLayout((layout) => {
  writeProject(layout, "Demo");
  assert.ok("sessionTitle" in hookOutput(runHook(layout, event()).out));
  const again = hookOutput(runHook(layout, event()).out);
  assert.ok(!("sessionTitle" in again));
  assert.ok(again.additionalContext.includes("session-titles"));
}));

test("after a compaction or a resume, SessionStart names the written purpose and asks for a rewrite", { skip }, () =>
  withLayout((layout) => {
    writeProject(layout, "Demo");
    purposeInTitles(layout, "fix the login bug");
    for (const source of ["compact", "resume"]) {
      const { additionalContext } = hookOutput(runHook(layout, { ...event(), source }).out);
      assert.match(additionalContext, /purpose as "fix the login bug"/, source);
      assert.match(additionalContext, /If the work has moved on/, source);
    }
    const fresh = hookOutput(runHook(layout, { ...event(), source: "startup" }).out);
    assert.match(fresh.additionalContext, /Once the session's focus is clear/);
  }));

test("a new purpose after a title was set prints the new title, once", { skip }, () => withLayout((layout) => {
  writeProject(layout, "Demo");
  runHook(layout, event());
  purposeInTitles(layout, "fix the login bug");
  assert.equal(hookOutput(runHook(layout, event("UserPromptSubmit")).out).sessionTitle, "Demo - fix the login bug");
  assert.equal(runHook(layout, event("UserPromptSubmit")).out, "");
}));

test("a newer purpose in the repo keeps the title on the next prompt too", { skip }, () => withLayout((layout) => {
  writeProject(layout, "Demo");
  ageFile(purposeInTitles(layout, "old titles focus"), 2);
  purposeInRepo(layout, "new repo focus");
  assert.equal(hookOutput(runHook(layout, event("UserPromptSubmit")).out).sessionTitle, "Demo - new repo focus");
  assert.equal(runHook(layout, event("UserPromptSubmit")).out, "");
  assert.equal(titleRecord(layout), "Demo - new repo focus");
}));

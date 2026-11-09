// session-title.py runs on a throwaway project folder in the OS temp dir. Every
// case is checked by what the hook prints, the status it exits with and the
// files it leaves on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = join(repo, "_core", "project-template", ".claude", "hooks", "session-title.py");
const skip = !python && "needs Python 3.8+";
const SESSION = "abc-123";

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "bw-title-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const bindwright = (root) => join(root, ".bindwright");
const sessions = (root) => join(bindwright(root), "sessions");

function writeProject(root, name) {
  mkdirSync(bindwright(root), { recursive: true });
  writeFileSync(join(bindwright(root), "project.json"), JSON.stringify({ project: { name } }));
}

function writePurpose(root, text) {
  mkdirSync(sessions(root), { recursive: true });
  writeFileSync(join(sessions(root), `${SESSION}.purpose`), text);
}

function event(hookEventName = "SessionStart", sessionId = SESSION) {
  return { hook_event_name: hookEventName, session_id: sessionId, cwd: "/elsewhere" };
}

function runHook(root, input) {
  const r = spawnSync(python, ["-I", hook], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { status: r.status, out: r.stdout };
}

const hookOutput = (out) => JSON.parse(out).hookSpecificOutput;

const cases = [
  {
    name: "no project file: prints nothing and creates no sessions folder",
    project: undefined,
    input: event(),
    check(root, run) {
      assert.equal(run.status, 0);
      assert.equal(run.out, "");
      assert.equal(existsSync(sessions(root)), false);
    },
  },
  {
    name: "a project name alone titles the session with the name",
    project: "Demo",
    input: event(),
    check(root, run) {
      assert.equal(run.status, 0);
      assert.deepEqual(hookOutput(run.out), { hookEventName: "SessionStart", sessionTitle: "Demo" });
      assert.equal(readFileSync(join(sessions(root), ".gitignore"), "utf8"), "*\n");
      assert.equal(readFileSync(join(sessions(root), `${SESSION}.title`), "utf8"), "Demo");
    },
  },
  {
    name: "the input's event name is echoed back",
    project: "Demo",
    input: event("UserPromptSubmit"),
    check(root, run) {
      assert.equal(hookOutput(run.out).hookEventName, "UserPromptSubmit");
    },
  },
  {
    name: "a 14-word purpose with a newline keeps its first 10 words",
    project: "Demo",
    purpose: "one two three four five\nsix seven eight nine ten eleven twelve thirteen fourteen",
    input: event(),
    check(root, run) {
      assert.equal(hookOutput(run.out).sessionTitle, "Demo - one two three four five six seven eight nine ten");
    },
  },
  {
    name: "a session id with ../ prints nothing and writes nothing outside the sessions folder",
    project: "Demo",
    input: event("SessionStart", "../escape"),
    check(root, run) {
      assert.equal(run.status, 0);
      assert.equal(run.out, "");
      assert.deepEqual(readdirSync(bindwright(root)), ["project.json"]);
    },
  },
  {
    name: "invalid JSON on stdin prints nothing and exits 0",
    project: "Demo",
    input: "{not json",
    check(root, run) {
      assert.equal(run.status, 0);
      assert.equal(run.out, "");
    },
  },
];

for (const row of cases) {
  test(row.name, { skip }, () => withRoot((root) => {
    if (row.project !== undefined) writeProject(root, row.project);
    if (row.purpose !== undefined) writePurpose(root, row.purpose);
    row.check(root, runHook(root, row.input));
  }));
}

test("the same event twice prints the title once", { skip }, () => withRoot((root) => {
  writeProject(root, "Demo");
  assert.equal(hookOutput(runHook(root, event()).out).sessionTitle, "Demo");
  assert.equal(runHook(root, event()).out, "");
}));

test("a new purpose after a title was set prints the new title, once", { skip }, () => withRoot((root) => {
  writeProject(root, "Demo");
  runHook(root, event());
  writePurpose(root, "fix the login bug");
  assert.equal(hookOutput(runHook(root, event()).out).sessionTitle, "Demo - fix the login bug");
  assert.equal(runHook(root, event()).out, "");
}));

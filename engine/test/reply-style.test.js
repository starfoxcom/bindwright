// reply-style.py (the global hook) runs with the home folder and the project in a throwaway folder
// in the OS temp dir. Every case is checked by what the hook prints and the status it exits with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = join(repo, "_core", "global-template", "hooks", "reply-style.py");
const skip = !python && "needs Python 3.8+";
const STYLE = "---\nname: Plain Speech\ndescription: d\n---\n\nAnswer first, in plain words.\n";

function withLayout(fn) {
  const base = mkdtempSync(join(tmpdir(), "bw-style-"));
  const home = join(base, "home");
  const root = join(base, "repo");
  mkdirSync(join(home, ".claude", "output-styles"), { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "output-styles", "plain.md"), STYLE);
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Plain Speech" }));
  try {
    return fn({ home, root });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function run({ home, root }, event) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root };
  delete env.CLAUDE_CONFIG_DIR;
  const input = typeof event === "string" ? event : JSON.stringify(event);
  const out = spawnSync(python, [hook], { input, env, encoding: "utf8" });
  return { status: out.status, context: out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null };
}

const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s-1" };
const toolCall = { hook_event_name: "PostToolUse", session_id: "s-1" };

test("every prompt ends with the active style's text", { skip }, () => withLayout((layout) => {
  const { status, context } = run(layout, prompt);
  assert.equal(status, 0);
  assert.equal(context.hookEventName, "UserPromptSubmit");
  assert.match(context.additionalContext, /Plain Speech/);
  assert.match(context.additionalContext, /Answer first, in plain words\.$/);
  assert.doesNotMatch(context.additionalContext, /description: d/);
}));

test("the project's own setting picks the style", { skip }, () => withLayout((layout) => {
  writeFileSync(join(layout.root, ".claude", "settings.local.json"), JSON.stringify({ outputStyle: "Default" }));
  assert.deepEqual(run(layout, prompt), { status: 0, context: null });
}));

test("a style with no file, a broken settings file or bad input adds nothing", { skip }, () => withLayout((layout) => {
  writeFileSync(join(layout.home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Explanatory" }));
  assert.deepEqual(run(layout, prompt), { status: 0, context: null });
  writeFileSync(join(layout.home, ".claude", "settings.json"), "{not json");
  assert.deepEqual(run(layout, prompt), { status: 0, context: null });
  assert.deepEqual(run(layout, "not json"), { status: 0, context: null });
}));

test("every 25th tool call since the last prompt brings the style back", { skip }, () => withLayout((layout) => {
  const calls = (n) => Array.from({ length: n }, () => run(layout, toolCall).context);
  assert.ok(calls(24).every((context) => context === null));
  assert.equal(run(layout, toolCall).context.hookEventName, "PostToolUse");
  calls(10);
  run(layout, prompt);
  assert.ok(calls(24).every((context) => context === null));
  assert.notEqual(run(layout, toolCall).context, null);
}));

test("a session id that could leave the counts folder is never counted", { skip }, () => withLayout((layout) => {
  const escape = { hook_event_name: "PostToolUse", session_id: "../x" };
  assert.ok(Array.from({ length: 25 }, () => run(layout, escape)).every((r) => r.status === 0 && !r.context));
}));

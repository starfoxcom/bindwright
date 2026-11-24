// reply-style.py (the global hook) runs with the home folder and the project in a throwaway folder
// in the OS temp dir. Every case is checked by what the hook prints and the status it exits with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
  // -I, as the installed entry starts it: no PYTHONUTF8 or PYTHONIOENCODING can fix the encoding.
  const out = spawnSync(python, ["-I", hook], { input: Buffer.from(input, "utf8"), env, encoding: "utf8" });
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

test("a prompt in any language and files saved with a BOM still get the style", { skip }, () => withLayout((layout) => {
  writeFileSync(join(layout.home, ".claude", "settings.json"), "﻿" + JSON.stringify({ outputStyle: "Plain Speech" }));
  writeFileSync(join(layout.home, ".claude", "output-styles", "plain.md"), "﻿" + STYLE);
  const { context } = run(layout, { ...prompt, prompt: "¿Qué pasó? ÁÍÏÝ ” 日本語 🎉" });
  assert.match(context.additionalContext, /Answer first, in plain words\.$/);
}));

test("a style is named by its name, and by its file only when it has none", { skip }, () => withLayout((layout) => {
  const styleFile = join(layout.home, ".claude", "output-styles", "plain.md");
  writeFileSync(join(layout.home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "plain" }));
  assert.equal(run(layout, prompt).context, null);
  writeFileSync(styleFile, "---\nname:\ndescription: d\n---\nBody.\n");
  assert.match(run(layout, prompt).context.additionalContext, /Body\.$/);
  // An empty header, or one closed at the end of the file, is still a header, never the style.
  writeFileSync(styleFile, "---\n---\nBody.\n");
  assert.equal(run(layout, prompt).context.additionalContext.split("\n\n").pop(), "Body.");
  writeFileSync(styleFile, "---\nname: Plain Speech\ndescription: d\n---");
  assert.equal(run(layout, prompt).context, null);
  // A header never closed is no header, so the file is named by its file name.
  writeFileSync(styleFile, "---\nname: Plain Speech\nBody.\n");
  assert.match(run(layout, prompt).context.additionalContext, /name: Plain Speech\nBody\.$/);
}));

test("parallel tool calls bring the style back exactly once in 25", { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), "bw-style-"));
  const home = join(base, "home");
  mkdirSync(join(home, ".claude", "output-styles"), { recursive: true });
  writeFileSync(join(home, ".claude", "output-styles", "plain.md"), STYLE);
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Plain Speech" }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: base };
  delete env.CLAUDE_CONFIG_DIR;
  const call = () => new Promise((done) => {
    const child = spawn(python, ["-I", hook], { env });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => done(out));
    child.stdin.end(JSON.stringify(toolCall));
  });
  try {
    const outputs = await Promise.all(Array.from({ length: 50 }, call));
    assert.equal(outputs.filter(Boolean).length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a subagent's tool calls are not counted", { skip }, () => withLayout((layout) => {
  const subagent = { ...toolCall, agent_id: "a-1" };
  assert.ok(Array.from({ length: 25 }, () => run(layout, subagent).context).every((context) => context === null));
  assert.ok(Array.from({ length: 24 }, () => run(layout, toolCall).context).every((context) => context === null));
  assert.notEqual(run(layout, toolCall).context, null);
}));

const SLIPPED = [
  "## Done", "", "**Outcome:** it works — mostly — and basically holds.", "- **Next:** ship it", "",
  // Emphasis, bold that ends a sentence, names an option or sits in a hyphenated word, and two clauses:
  // none of it is a slip.
  "**Do not** run it yet.", "**Don't merge until CI is green.**", "- **Merge now**",
  "Is that not just a typo? I checked but found nothing.", "**Ctrl**-C stops it.",
  "- **Pre**-release builds come first.", "",
  // A paragraph with any backtick, wrapped, escaped or stray, or with a line indented like code after
  // any mix of spaces, tabs, quote marks and list markers, is not measured at all.
  "Run `## x —` here, and ``a ` — b`` too.", "", "Run `git log", "--format=%s — %an", "--no-merges` to see it.", "",
  "Wrap it in \\` like `a — b` with a closing \\`.", "", "- use ` to quote", "- run `a — b`", "- and ` again", "",
  "    echo \"a — b\"  # basically", "", ">     code — basically", "", "  \ta — b", "", "-     a — b", "",
  "  -     a — b", "", " 1.     basically", "", "- >     a — b", "", "- -     a — b", "",
  "Then it holds, essentially.",
  // From the first fence mark on, nothing is measured, whatever the fences hold or wherever they end.
  "A fence opens with ``` on its own line.", "Prose — basically, **Note:** essentially.", "```md", "> ```",
  "> code — basically", "> ```", "```", "- **Note:** then — basically.",
].join("\n");
const finished = (reply) => ({ hook_event_name: "Stop", session_id: "s-1", last_assistant_message: reply });

test("what a finished reply broke comes with the next prompt, once", { skip }, () => withLayout((layout) => {
  const styleFile = join(layout.home, ".claude", "output-styles", "plain.md");
  writeFileSync(styleFile, STYLE.replace("Plain Speech", "Straight Talk"));
  writeFileSync(join(layout.home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Straight Talk" }));
  assert.deepEqual(run(layout, finished(SLIPPED)), { status: 0, context: null });
  const slips = "so this one avoids them: a bold label at the start of a line or list item (2);"
    + ' an em dash (2); "essentially"; "basically".';
  assert.ok(run(layout, prompt).context.additionalContext.endsWith(slips));
  const rate = (clean, checked, pct) =>
    new RegExp(`plain words\\.\\n\\nThis session so far: ${clean} of ${checked} replies kept the measured rules`
      + ` \\(${pct}%\\), against a 90% goal\\.$`);
  assert.match(run(layout, prompt).context.additionalContext, rate(0, 1, 0));
  run(layout, finished(SLIPPED));
  run(layout, finished("All clean, plain words."));
  assert.match(run(layout, prompt).context.additionalContext, rate(1, 3, 33));
}));

// The checked style under its own name, in a fresh layout.
function straight(layout) {
  const styleFile = join(layout.home, ".claude", "output-styles", "plain.md");
  writeFileSync(styleFile, STYLE.replace("Plain Speech", "Straight Talk"));
  writeFileSync(join(layout.home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Straight Talk" }));
}
const CLEAN = "All clean, plain words.";
const replies = (layout, session, texts) =>
  texts.forEach((text) => run(layout, { hook_event_name: "Stop", session_id: session, last_assistant_message: text }));
const promptOf = (layout, session) =>
  run(layout, { hook_event_name: "UserPromptSubmit", session_id: session }).context.additionalContext;

test("a session at or above the goal gets a pointer, and the whole text once it falls below", { skip }, () =>
  withLayout((layout) => {
    straight(layout);
    replies(layout, "s-1", Array(5).fill(CLEAN));
    const pointer = promptOf(layout, "s-1");
    assert.match(pointer, /Straight Talk, is in the system prompt/);
    assert.match(pointer, /held in 5 of 5 replies of this session \(100%\), at or above the 90% goal/);
    assert.doesNotMatch(pointer, /Answer first/);
    // 5 of 6 is 83%: the whole text comes back, with the rate and the slip.
    replies(layout, "s-1", ["It holds — mostly."]);
    const full = promptOf(layout, "s-1");
    assert.match(full, /Answer first, in plain words\./);
    assert.match(full, /5 of 6 replies kept the measured rules \(83%\)/);
    assert.ok(full.endsWith("so this one avoids them: an em dash."));
    // 43 of 48 is 89.6%: it shows as 90 but falls short of the goal, so the whole text comes back.
    const folder = join(layout.home, ".bindwright", "reply-style");
    writeFileSync(join(folder, "s-9.record"), JSON.stringify({ checked: 48, clean: 43, slips: {} }));
    assert.match(promptOf(layout, "s-9"), /Answer first, in plain words\.\n\nThis session so far: 43 of 48 .*\(90%\)/);
    // The record holds counts, never the reply's words.
    const record = readFileSync(join(layout.home, ".bindwright", "reply-style", "s-1.record"), "utf8");
    assert.deepEqual(JSON.parse(record), { checked: 6, clean: 5, slips: { "an em dash": 1 } });
  }));

test("a new session goes by the last session's record until it has five replies of its own", { skip }, () =>
  withLayout((layout) => {
    straight(layout);
    assert.match(promptOf(layout, "s-2"), /Answer first, in plain words\.$/);
    replies(layout, "s-1", Array(5).fill(CLEAN));
    assert.match(promptOf(layout, "s-2"), /held in 5 of 5 replies of the last session/);
    // A clean start borrows the record and names its own rate; one slip before five takes the whole text.
    replies(layout, "s-3", [CLEAN]);
    const borrowed = promptOf(layout, "s-3");
    assert.match(borrowed, /of the last session \(100%\)/);
    assert.match(borrowed, /This session so far: 1 of 1 replies kept the measured rules \(100%\)/);
    replies(layout, "s-3", ["It holds — mostly."]);
    assert.match(promptOf(layout, "s-3"), /Answer first, in plain words\.\n\nThis session so far: 1 of 2/);
    // Counts written as true or false are no record.
    const folder = join(layout.home, ".bindwright", "reply-style");
    writeFileSync(join(folder, "s-1.record"), JSON.stringify({ checked: true, clean: true, slips: {} }));
    assert.match(promptOf(layout, "s-2"), /Answer first, in plain words\.$/);
    replies(layout, "s-2", Array(5).fill("It holds — mostly."));
    assert.match(promptOf(layout, "s-2"), /0 of 5 replies kept the measured rules \(0%\)/);
  }));

const report = ({ home }) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  return JSON.parse(spawnSync(python, ["-I", hook, "--report"], { env, encoding: "utf8" }).stdout);
};

test("the report asks for the assess step when the last three sessions fell short", { skip }, () =>
  withLayout((layout) => {
    straight(layout);
    assert.deepEqual(report(layout), { goal: 90, sessions: [], assess: false, worst: null });
    for (const session of ["s-1", "s-2", "s-3"]) {
      replies(layout, session, [...Array(4).fill(CLEAN), "It holds — mostly — and basically."]);
    }
    // Three replies short of five are no session's record yet.
    replies(layout, "s-4", ["It holds — mostly."]);
    const short = report(layout);
    assert.deepEqual(short.sessions.map((s) => s.rate), [80, 80, 80]);
    assert.equal(short.assess, true);
    assert.deepEqual(short.worst, { rule: "an em dash", count: 6 });
    writeFileSync(join(layout.home, ".bindwright", "reply-style", "config.json"), JSON.stringify({ goal: 75 }));
    assert.deepEqual({ ...report(layout), sessions: [] }, { goal: 75, sessions: [], assess: false, worst: null });
  }));

test("only the newest twenty session records are kept", { skip }, () => withLayout((layout) => {
  straight(layout);
  const folder = join(layout.home, ".bindwright", "reply-style");
  mkdirSync(folder, { recursive: true });
  for (let i = 0; i < 21; i++) {
    const path = join(folder, `old-${i}.record`);
    writeFileSync(path, JSON.stringify({ checked: 1, clean: 1, slips: {} }));
    utimesSync(path, 1_000_000 + i, 1_000_000 + i);
  }
  replies(layout, "s-1", [CLEAN]);
  const kept = readdirSync(folder).filter((name) => name.endsWith(".record")).sort();
  assert.equal(kept.length, 20);
  assert.ok(kept.includes("s-1.record") && !kept.includes("old-0.record") && !kept.includes("old-1.record"));
}));

test("replies under another style are not measured, nor named after a switch", { skip }, () => withLayout((layout) => {
  run(layout, finished(SLIPPED));
  assert.match(run(layout, prompt).context.additionalContext, /Answer first, in plain words\.$/);
  const straight = join(layout.home, ".claude", "output-styles", "straight.md");
  writeFileSync(straight, "---\nname: Straight Talk\n---\nPlain.\n");
  writeFileSync(join(layout.home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Straight Talk" }));
  run(layout, finished(SLIPPED));
  writeFileSync(join(layout.home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Plain Speech" }));
  assert.match(run(layout, prompt).context.additionalContext, /Answer first, in plain words\.$/);
}));

test("a session id that could leave the counts folder is never counted", { skip }, () => withLayout((layout) => {
  const escape = { hook_event_name: "PostToolUse", session_id: "../x" };
  assert.ok(Array.from({ length: 25 }, () => run(layout, escape)).every((r) => r.status === 0 && !r.context));
}));

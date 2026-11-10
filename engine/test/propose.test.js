// Setup's merge proposals (--propose-merge, propose.js and propose.py): each row runs both
// engines through their CLIs on a temp repo. The Python engine must print the same bytes as the
// JS engine, and both must print the expected proposals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const INCOMING = [".bindwright", "incoming"];

const ENGINES = {
  node: (repo) => spawnSync(
    process.execPath, [join(engine, "cli.js"), "--propose-merge", repo], { encoding: "utf8" }),
  python: (repo) => spawnSync(
    python, ["-I", join(engine, "bind.py"), "--propose-merge", repo], { encoding: "utf8" }),
};

// The text setup's engines print for a JSON object: two-space indent, one trailing newline.
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const json = (value) => JSON.stringify(value);

function jsonProposal(path, merged, clashes = []) {
  return { path, kind: "json", merged, text: pretty(merged), clashes };
}

const hookEntry = (command) => ({ matcher: "Bash", hooks: [{ type: "command", command }] });
const writeEntry = { matcher: "Write", hooks: [{ type: "command", command: "write.py" }] };

const FENCED = "```\n# Inside\n```\n~~~\n## Two\n~~~\n";

// Each row: the repo's files, the staged files (null: no staging folder at all) and the
// proposals the engines must print. Paths are relative to the repo root and to the staging folder.
const KINDS = {
  folders: [
    { name: "missing incoming folder", repo: { "a.json": "{}" }, incoming: null, expect: [] },
    { name: "empty incoming folder", repo: {}, incoming: {}, expect: [] },
    {
      name: "staged files come back in path order",
      repo: {},
      incoming: { "b.txt": "x", "a.txt": "y", "sub/c.txt": "z" },
      expect: [
        { path: "a.txt", kind: "missing" },
        { path: "b.txt", kind: "missing" },
        { path: "sub/c.txt", kind: "missing" },
      ],
    },
  ],
  missing: [
    {
      name: "repo has no file at the path",
      repo: {},
      incoming: { LICENSE: "MIT" },
      expect: [{ path: "LICENSE", kind: "missing" }],
    },
    {
      name: "nested path the repo lacks",
      repo: { "other.txt": "x" },
      incoming: { ".claude/settings.json": "{}" },
      expect: [{ path: ".claude/settings.json", kind: "missing" }],
    },
  ],
  identical: [
    {
      name: "same text",
      repo: { "notes.txt": "a\nb\n" },
      incoming: { "notes.txt": "a\nb\n" },
      expect: [{ path: "notes.txt", kind: "identical" }],
    },
    {
      name: "CRLF against LF",
      repo: { "settings.json": "{\"a\": 1}\r\n" },
      incoming: { "settings.json": "{\"a\": 1}\n" },
      expect: [{ path: "settings.json", kind: "identical" }],
    },
  ],
  json: [
    {
      name: "disjoint keys: staged keys appended",
      repo: { "s.json": json({ a: 1, b: { x: true } }) },
      incoming: { "s.json": json({ c: 2, d: "y" }) },
      expect: [jsonProposal("s.json", { a: 1, b: { x: true }, c: 2, d: "y" })],
    },
    {
      name: "clashing scalar keeps the repo's value",
      repo: { "s.json": json({ permissions: { defaultMode: "plan" } }) },
      incoming: { "s.json": json({ permissions: { defaultMode: "acceptEdits" } }) },
      expect: [jsonProposal("s.json", { permissions: { defaultMode: "plan" } },
        [{ key: "permissions.defaultMode", repo: "plan", incoming: "acceptEdits" }])],
    },
    {
      name: "permission lists unioned without duplicates",
      repo: { "s.json": json({ permissions: { allow: ["Bash(git status)", "Read"] } }) },
      incoming: {
        "s.json": json({
          permissions: { allow: ["Read", "Bash(npm test)"], deny: ["Bash(rm -rf *)"] },
        }),
      },
      expect: [jsonProposal("s.json", {
        permissions: {
          allow: ["Bash(git status)", "Read", "Bash(npm test)"],
          deny: ["Bash(rm -rf *)"],
        },
      })],
    },
    {
      name: "duplicate hook not re-added, new hook appended",
      repo: { "s.json": json({ hooks: { PreToolUse: [hookEntry("guard.py")] } }) },
      incoming: {
        "s.json": json({
          hooks: {
            PreToolUse: [
              { hooks: [{ command: "guard.py", type: "command" }], matcher: "Bash" },
              writeEntry,
            ],
          },
        }),
      },
      expect: [jsonProposal("s.json", {
        hooks: { PreToolUse: [hookEntry("guard.py"), writeEntry] },
      })],
    },
    {
      name: "nested objects merge key by key",
      repo: { "s.json": json({ env: { A: "1" }, model: "x" }) },
      incoming: { "s.json": json({ env: { B: "2" } }) },
      expect: [jsonProposal("s.json", { env: { A: "1", B: "2" }, model: "x" })],
    },
    {
      name: "other arrays that differ are a clash",
      repo: { "s.json": json({ tags: [1] }) },
      incoming: { "s.json": json({ tags: [2] }) },
      expect: [jsonProposal("s.json", { tags: [1] }, [{ key: "tags", repo: [1], incoming: [2] }])],
    },
    {
      name: "nested path such as .claude/settings.json",
      repo: { ".claude/settings.json": json({ model: "a" }) },
      incoming: { ".claude/settings.json": json({ model: "b", x: 1 }) },
      expect: [jsonProposal(".claude/settings.json", { model: "a", x: 1 },
        [{ key: "model", repo: "a", incoming: "b" }])],
    },
    {
      name: "non-ASCII and escaped text prints the same bytes",
      repo: { "s.json": json({ name: "Café", q: 'say "hi"	now' }) },
      incoming: { "s.json": json({ name: "Ñandú", x: "→" }) },
      expect: [jsonProposal("s.json", { name: "Café", q: 'say "hi"	now', x: "→" },
        [{ key: "name", repo: "Café", incoming: "Ñandú" }])],
    },
    {
      name: "invalid JSON falls back to text",
      repo: { "s.json": "{not json" },
      incoming: { "s.json": "{}" },
      expect: [{ path: "s.json", kind: "text" }],
    },
    {
      name: "a JSON array is not an object, so text",
      repo: { "s.json": "[]" },
      incoming: { "s.json": "{}" },
      expect: [{ path: "s.json", kind: "text" }],
    },
    {
      name: "a whole number written 1.0 equals 1 and prints as 1",
      repo: { "s.json": '{"a": 1.0, "b": 1e2}' },
      incoming: { "s.json": '{"a": 1, "c": -0.0}' },
      expect: [jsonProposal("s.json", { a: 1, b: 100, c: 0 })],
    },
    {
      name: "a non-ASCII digit key is an ordinary key",
      repo: { "s.json": '{"b": 1, "²": 2}' },
      incoming: { "s.json": '{"a": 1}' },
      expect: [jsonProposal("s.json", { b: 1, "²": 2, a: 1 })],
    },
    ...[
      ["a fraction", '{"a": 1.5, "a": 1}'],
      ["a number too large for a double", '{"a": 1e999, "a": 1}'],
      ["a whole number past the safe range", '{"a": 12345678901234567890123, "a": 1}'],
      ["an integer too long to convert", `{"a": ${"9".repeat(5000)}, "a": 1}`],
    ].map(([what, text]) => ({
      name: `${what} under a key repeated later is replaced, as JSON.parse keeps the last`,
      repo: { "s.json": text },
      incoming: { "s.json": '{"z": 0}' },
      expect: [jsonProposal("s.json", { a: 1, z: 0 })],
    })),
    {
      name: "a top-level key named permissions.allow is not a permission list",
      repo: { "s.json": '{"permissions.allow": ["a"]}' },
      incoming: { "s.json": '{"permissions.allow": ["b"]}' },
      expect: [jsonProposal("s.json", { "permissions.allow": ["a"] },
        [{ key: "permissions.allow", repo: ["a"], incoming: ["b"] }])],
    },
    ...[
      ["a fraction", '{"a": 1.5}'],
      ["a whole number past the safe range", '{"a": 12345678901234567890123}'],
      ["an exponent past the safe range", '{"a": 1e16}'],
      ["a number too large for a double", '{"a": 1e999}'],
      ["an all-digit key", '{"2": 2, "b": 1}'],
      ["a lone surrogate in a value", '{"a": "\\ud800"}'],
      ["a lone surrogate in a key", '{"\\udc00": 1}'],
      ["nesting past 64 levels", `${"[".repeat(65)}${"]".repeat(65)}`.replace(/^/, '{"a": ') + "}"],
    ].map(([what, text]) => ({
      name: `${what} in the repo's copy is not plain JSON, so text`,
      repo: { "s.json": text },
      incoming: { "s.json": '{"z": 0}' },
      expect: [{ path: "s.json", kind: "text" }],
    })),
  ],
  markdown: [
    {
      name: "a section only the staged copy has is added",
      repo: { "README.md": "# Title\n\nintro\n\n## A\nbody a\n" },
      incoming: { "README.md": "# Title\n\nintro\n\n## A\nbody a\n\n## B\nnew\n" },
      expect: [{
        path: "README.md",
        kind: "markdown",
        add: [{ heading: "## B", text: "## B\nnew\n" }],
        differ: [],
        repoOnly: [],
      }],
    },
    {
      name: "a section only the repo has is listed",
      repo: { "README.md": "# Title\n\n## A\na\n\n## C\nc\n" },
      incoming: { "README.md": "# Title\n\n## A\na\n" },
      expect: [{ path: "README.md", kind: "markdown", add: [], differ: [], repoOnly: ["## C"] }],
    },
    {
      name: "a section that differs is reported with both texts",
      repo: { "README.md": "## A\nold\n" },
      incoming: { "README.md": "## A\nnew\n" },
      expect: [{
        path: "README.md",
        kind: "markdown",
        add: [],
        differ: [{ heading: "## A", repo: "## A\nold\n", incoming: "## A\nnew\n" }],
        repoOnly: [],
      }],
    },
    {
      name: "trailing spaces alone are not a difference",
      repo: { "README.md": "## A\nold   \n" },
      incoming: { "README.md": "## A\nold\n" },
      expect: [{ path: "README.md", kind: "markdown", add: [], differ: [], repoOnly: [] }],
    },
    {
      name: "text before the first heading is compared as the empty heading",
      repo: { "README.md": "intro one\n## A\nx\n" },
      incoming: { "README.md": "intro two\n## A\nx\n" },
      expect: [{
        path: "README.md",
        kind: "markdown",
        add: [],
        differ: [{ heading: "", repo: "intro one", incoming: "intro two" }],
        repoOnly: [],
      }],
    },
    {
      name: "a heading inside a code fence is not split",
      repo: { "DOC.md": `## Real\nold\n${FENCED}` },
      incoming: { "DOC.md": `## Real\nnew\n${FENCED}` },
      expect: [{
        path: "DOC.md",
        kind: "markdown",
        add: [],
        differ: [{
          heading: "## Real",
          repo: `## Real\nold\n${FENCED}`,
          incoming: `## Real\nnew\n${FENCED}`,
        }],
        repoOnly: [],
      }],
    },
    {
      name: "repeated headings match by occurrence",
      repo: { "README.md": "## Notes\nfirst\n## Notes\nsecond\n" },
      incoming: { "README.md": "## Notes\nfirst\n## Notes\nchanged\n## Notes\nthird\n" },
      expect: [{
        path: "README.md",
        kind: "markdown",
        add: [{ heading: "## Notes", text: "## Notes\nthird\n" }],
        differ: [{
          heading: "## Notes",
          repo: "## Notes\nsecond\n",
          incoming: "## Notes\nchanged",
        }],
        repoOnly: [],
      }],
    },
  ],
  text: [
    {
      name: "a licence that differs",
      repo: { LICENSE: "MIT" },
      incoming: { "LICENSE": "Apache-2.0" },
      expect: [{ path: "LICENSE", kind: "text" }],
    },
    {
      name: "a YAML file that differs",
      repo: { "ci.yml": "on: push\n" },
      incoming: { "ci.yml": "on: pull_request\n" },
      expect: [{ path: "ci.yml", kind: "text" }],
    },
  ],
};

function writeFiles(folder, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
}

// A repo with its own copy of `repo`, and a staging folder holding `incoming` unless it is null.
function fixture({ repo, incoming }) {
  const root = mkdtempSync(join(tmpdir(), "propose-"));
  writeFiles(root, repo);
  if (incoming !== null) {
    mkdirSync(join(root, ...INCOMING), { recursive: true });
    writeFiles(join(root, ...INCOMING), incoming);
  }
  return root;
}

// The stdout of one engine on `root`, which must exit 0.
function printedIn(root, propose) {
  const done = propose(root);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  return done.stdout;
}

// The stdout of one engine on a fresh repo built from `row`.
function printed(row, propose) {
  const root = fixture(row);
  try {
    return printedIn(root, propose);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const pythonSkip = python ? false : "no Python 3.8+ found";

for (const [kind, rows] of Object.entries(KINDS)) {
  for (const row of rows) {
    test(`node: ${kind}: ${row.name}`, () => {
      assert.deepEqual(JSON.parse(printed(row, ENGINES.node)), { proposals: row.expect });
    });
    test(`python: ${kind}: ${row.name}`, { skip: pythonSkip }, () => {
      const out = printed(row, ENGINES.python);
      assert.equal(out, printed(row, ENGINES.node));
      assert.deepEqual(JSON.parse(out), { proposals: row.expect });
    });
  }
}

// A folder link that needs no admin rights on Windows (a junction), as staging.test.js makes it.
function linkFolder(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

for (const [name, propose] of Object.entries(ENGINES)) {
  const skip = name === "python" ? pythonSkip : false;

  test(`${name}: a folder link under incoming is skipped, not followed`, { skip }, () => {
    const root = fixture({ repo: {}, incoming: { "real.txt": "x" } });
    const outside = mkdtempSync(join(tmpdir(), "propose-outside-"));
    try {
      writeFileSync(join(outside, "secret.json"), "{}");
      linkFolder(outside, join(root, ...INCOMING, "linked"));
      assert.deepEqual(JSON.parse(printedIn(root, propose)), {
        proposals: [{ path: "real.txt", kind: "missing" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test(`${name}: a repo copy reached through a link is read only inside the repo`, { skip }, () => {
    const root = fixture({
      repo: { "real/notes.md": "# Notes\nmine\n" },
      incoming: { "inside/notes.md": "# Notes\nnew\n", "outside/settings.json": "{\"a\": 2}" },
    });
    const outside = mkdtempSync(join(tmpdir(), "propose-outside-"));
    try {
      writeFileSync(join(outside, "settings.json"), "{\"secret\": 1}");
      linkFolder(join(root, "real"), join(root, "inside"));
      linkFolder(outside, join(root, "outside"));
      const [inside, linkedOut] = JSON.parse(printedIn(root, propose)).proposals;
      assert.equal(inside.kind, "markdown");
      assert.deepEqual(linkedOut, { path: "outside/settings.json", kind: "text" });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test(`${name}: a folder at a staged file's path is text, and the others still come back`,
    { skip }, () => {
      const root = fixture({ repo: { "a.md": "# A\n" }, incoming: { "a.md": "# A\nnew\n" } });
      try {
        mkdirSync(join(root, "dir.json"));
        writeFileSync(join(root, ...INCOMING, "dir.json"), "{}");
        assert.deepEqual(JSON.parse(printedIn(root, propose)).proposals.map((p) => p.kind),
          ["markdown", "text"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

  test(`${name}: a linked .bindwright folder is not followed`, { skip }, () => {
    const root = fixture({ repo: { "a.json": "{}" }, incoming: null });
    const outside = mkdtempSync(join(tmpdir(), "propose-outside-"));
    try {
      mkdirSync(join(outside, "incoming"));
      writeFileSync(join(outside, "incoming", "a.json"), "{\"secret\": 1}");
      rmSync(join(root, ".bindwright"), { recursive: true, force: true });
      linkFolder(outside, join(root, ".bindwright"));
      assert.deepEqual(JSON.parse(printedIn(root, propose)), { proposals: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test(`${name}: a file link under incoming is skipped, not followed`, { skip }, (t) => {
    const root = fixture({ repo: {}, incoming: { "real.txt": "x" } });
    const outside = mkdtempSync(join(tmpdir(), "propose-outside-"));
    try {
      const secret = join(outside, "secret.json");
      writeFileSync(secret, "{}");
      try {
        symlinkSync(secret, join(root, ...INCOMING, "link.json"), "file");
      } catch (err) {
        if (err.code === "EPERM") {
          return t.skip("this platform needs admin rights to make file links");
        }
        throw err;
      }
      assert.deepEqual(JSON.parse(printedIn(root, propose)), {
        proposals: [{ path: "real.txt", kind: "missing" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

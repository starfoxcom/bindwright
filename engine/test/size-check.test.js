// The code-size check a bind ships (.github/scripts/size_check.py), run on
// throwaway git repos. A stand-in lizard reads its functions from the
// LIZARD_STUB variable, so the function rows run the same with or without the
// real lizard installed; Python's -S keeps the real one out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";
import "./quiet-git.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(repo, "_core", "project-template", ".github", "scripts", "size_check.py");
const RULE = join(repo, "_core", "project-template", ".claude", "rules", "code-size.md");
const skip = !python && "needs Python 3.8+";

const SMALL_RULE = `---
paths:
  - "**/*.{py,rb,dart}"
---
| Construct | Soft | Hard |
|---|---|---|
| Parameters | 2 | 3 |
| Cyclomatic complexity per function | 3 | 5 |

| Language | File | Function | Line length |
|---|---|---|---|
| Python | 10 / 20 | 5 / 8 | 30 / 40 |
| Other | 1 000 / 1 500 (.x 9) | 50 / 100 | 100 / 120 |
`;

const STUB = `import json, os
class _F:
    def __init__(self, d):
        self.name, self.start_line, self.end_line = d["name"], 1, d["length"]
        self.cyclomatic_complexity = d.get("ccn", 1)
        self.parameters = d.get("names") or ["p"] * d.get("params", 0)
        self.parameter_count = len(self.parameters)
class _R:
    def __init__(self, fns): self.function_list = fns
def get_reader_for(path):
    return None if path.endswith(".dart") else object()
def _table(path):
    table = json.loads(os.environ.get("LIZARD_STUB", "{}"))
    return table.get(os.path.relpath(path, os.getcwd()).replace(os.sep, "/"), [])
class _Analyzer:
    def __call__(self, path): return _R([_F(d) for d in _table(path)])
    # TypeScript is read one top-level piece at a time; the first piece holds the table.
    def analyze_source_code(self, path, code):
        return _R([] if code.startswith("\\n") else [_F(d) for d in _table(path)])
analyze_file = _Analyzer()
`;

const lines = (n, width = 1) => `${Array.from({ length: n }, () => "x".repeat(width)).join("\n")}\n`;

// A git repo holding the script, a rule and the given files. Only the given
// files are staged, so the script and the stand-in are not measured.
function makeRepo(files, rule = SMALL_RULE) {
  const root = mkdtempSync(join(tmpdir(), "size-check-"));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  mkdirSync(join(root, ".github", "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, ".github", "scripts", "size_check.py"));
  put(".claude/rules/code-size.md", rule);
  put("stub/lizard.py", STUB);
  for (const [path, text] of Object.entries(files)) put(path, text);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "--", ...Object.keys(files)], { cwd: root });
  return { root, put, git: (...args) => spawnSync("git", args, { cwd: root }) };
}

function check(root, args = [], { stub = {}, lizard = true } = {}) {
  // A home of the repo's own, so a real ~/.bindwright on this machine is never read.
  const home = join(root, "home");
  const env = {
    ...process.env, LIZARD_STUB: JSON.stringify(stub), PYTHONPATH: lizard ? join(root, "stub") : "",
    HOME: home, USERPROFILE: home,
  };
  const r = spawnSync(python, ["-S", ".github/scripts/size_check.py", ...args], { cwd: root, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("a new hard breach fails, and the baseline lets it stay but never grow", { skip }, () => {
  const { root, put, git } = makeRepo({ "app.py": lines(21) });
  let r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SIZE_BREACH_NEW: app\.py: file - = 21 \(hard limit 20\)/);

  r = check(root, ["--write-baseline"]);
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(join(root, ".github/size-check/baseline.txt"), "utf8"), /^app\.py\|file\|-\|21$/m);
  git("add", ".github/size-check/baseline.txt");
  assert.equal(check(root).code, 0);

  put("app.py", lines(22));
  r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SIZE_BREACH_GREW: app\.py: file - = 22 \(baseline 21\)/);

  // Once the code complies, its baseline line must go, or it would excuse the next breach.
  put("app.py", lines(20));
  r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SIZE_LEDGER_LEFTOVER: app\.py\|file\|- is listed 1 times in the baseline but breaches 0 times/);
  put(".github/size-check/baseline.txt", "# path|construct|name|value\n");
  r = check(root, ["--report"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /soft: app\.py: file - = 20 \(soft limit 10\)/);
});

test("a new file not added to git is named, since CI would measure it", { skip }, () => {
  const { root, put } = makeRepo({ "app.py": "x\n" });
  put("new.py", lines(21));
  put(".gitignore", "ignored.py\n");
  put("ignored.py", lines(21));
  const r = check(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /note: \d+ new file\(s\) are not measured until added to git: .*new\.py/);
  assert.doesNotMatch(r.out, /ignored\.py/);
});

// Only Linux takes a file name that is not UTF-8; Windows and macOS refuse it.
test("a new file whose name is not UTF-8 is named, never a crash", { skip: skip || process.platform !== "linux" },
  () => {
    const { root } = makeRepo({ "app.py": "x\n" });
    writeFileSync(Buffer.concat([Buffer.from(`${root}/r`), Buffer.from([0xe9]), Buffer.from("sum.py")]), "x\n");
    const r = check(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /new file\(s\) are not measured until added to git: .*sum\.py/);
  });

test("a leftover same-named baseline line cannot excuse a new breach", { skip }, () => {
  const { root, put, git } = makeRepo({ "app.py": "x\n" });
  put(".github/size-check/baseline.txt", "app.py|function|(anonymous)|30\napp.py|function|(anonymous)|20\n");
  git("add", ".github/size-check/baseline.txt");
  // The 30-line one shrank below the limit and the 20-line one grew to 25.
  const r = check(root, [], { stub: { "app.py": [{ name: "(anonymous)", length: 25 }] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SIZE_LEDGER_LEFTOVER: app\.py\|function\|\(anonymous\) is listed 2 times .* breaches 1 times/);
});

test("each limit trips one step past its hard value, not at it", { skip }, () => {
  const stub = {
    "ok.py": [
      { name: "fine", length: 8, ccn: 5, params: 3 }, { name: "method", length: 2, names: ["self", "a", "b", "c"] },
    ],
    "bad.py": [
      { name: "long", length: 9 }, { name: "branchy", length: 2, ccn: 6 }, { name: "wide", length: 2, params: 4 },
      { name: "selfish", length: 2, names: ["a", "self", "b", "c"] },
    ],
  };
  const { root } = makeRepo({ "ok.py": lines(20, 40), "bad.py": `${"y".repeat(41)}\n${"y".repeat(41)}\n` });
  const r = check(root, [], { stub });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /ok\.py/);
  assert.match(r.out, /bad\.py: function long = 9 \(hard limit 8\)/);
  assert.match(r.out, /bad\.py: ccn branchy = 6 \(hard limit 5\)/);
  assert.match(r.out, /bad\.py: params wide = 4 \(hard limit 3\)/);
  // Only a leading self or cls is the method's own; a later one counts.
  assert.match(r.out, /bad\.py: params selfish = 4 \(hard limit 3\)/);
  assert.match(r.out, /bad\.py: line_length - = 2 \(hard limit 40\)/);
});

test("a second same-named breach is new, not hidden behind the recorded one", { skip }, () => {
  const one = [{ name: "(anonymous)", length: 12 }];
  const { root, git } = makeRepo({ "app.py": "x\n" });
  assert.equal(check(root, ["--write-baseline"], { stub: { "app.py": one } }).code, 0);
  git("add", ".github/size-check/baseline.txt");
  assert.equal(check(root, [], { stub: { "app.py": one } }).code, 0);

  const two = [...one, { name: "(anonymous)", length: 9 }];
  let r = check(root, [], { stub: { "app.py": two } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SIZE_BREACH_NEW: app\.py: function \(anonymous\) = 9/);
  r = check(root, [], { stub: { "app.py": [{ name: "(anonymous)", length: 13 }] } });
  assert.match(r.out, /SIZE_BREACH_GREW: app\.py: function \(anonymous\) = 13 \(baseline 12\)/);
});

test("a name holding the ledger's separator reads back from the baseline", { skip }, () => {
  const stub = { "app.py": [{ name: "operator|=", length: 12 }] };
  const { root, git } = makeRepo({ "app.py": "x\n" });
  assert.equal(check(root, ["--write-baseline"], { stub }).code, 0);
  git("add", ".github/size-check/baseline.txt");
  const r = check(root, [], { stub });
  assert.equal(r.code, 0, r.out);
});

test("a rule that names no file type fails instead of passing empty", { skip }, () => {
  const { root } = makeRepo({ "app.py": "x\n" }, "# Code size\n\nNo tables.\n");
  const r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SIZE_RULE_EMPTY/);
});

test("tests get half again the file limit, and skipped folders are out of scope", { skip }, () => {
  const { root } = makeRepo({
    "tests/test_app.py": lines(30), "app_test.py": lines(31),
    "vendor/big.py": lines(500), "node_modules/x/big.py": lines(500),
  });
  const r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /tests\/test_app\.py|vendor|node_modules/);
  assert.match(r.out, /app_test\.py: file - = 31 \(hard limit 30\)/);
});

test("exceptions cover a breach with a reason, and stale entries fail", { skip }, () => {
  const { root } = makeRepo({
    "gen.py": lines(25),
    "big.py": lines(25),
    ".github/size-check/exceptions.txt":
      "# why\ngen.py|file|-|generated table\nbig.py|file|*|codegen | see Makefile\ngone.py|file|*|deleted file\n",
  });
  const r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /SIZE_BREACH/);
  assert.match(r.out, /SIZE_LEDGER_STALE: gone\.py\|file\|\* names a file that is no longer tracked/);
});

test("without lizard the check fails loudly and writes no baseline", { skip }, () => {
  const { root } = makeRepo({ "app.py": lines(3) });
  let r = check(root, [], { lizard: false });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SIZE_CHECK_DEGRADED/);
  r = check(root, ["--write-baseline"], { lizard: false });
  assert.equal(r.code, 1, r.out);
  assert.ok(!existsSync(join(root, ".github/size-check/baseline.txt")));
});

test("lizard in the environment setup installs it in counts as installed", { skip }, () => {
  const { root, put } = makeRepo({ "app.py": "x\n" });
  // Another Python version's folder than the one running, as after a Homebrew upgrade.
  put("home/.bindwright/size-check-venv/lib/python3.99/site-packages/lizard.py", STUB);
  const r = check(root, [], { lizard: false, stub: { "app.py": [{ name: "long", length: 9 }] } });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /SIZE_CHECK_DEGRADED/);
  assert.match(r.out, /app\.py: function long = 9 \(hard limit 8\)/);
});

test("a language lizard cannot read still gets its file rows, with a note", { skip }, () => {
  const { root } = makeRepo({ "main.dart": lines(1501) });
  const r = check(root, ["--report"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /main\.dart: file - = 1501 \(hard limit 1500\)/);
  assert.match(r.out, /note: lizard reads no functions from \.dart files/);
});

test("the shipped rule's tables parse: named rows, Other, and spaced thousands", { skip }, () => {
  const files = { "a.py": lines(1001), "b.rb": lines(1201), "c.h": lines(1501), "d.ts": lines(800) };
  const { root } = makeRepo(files, readFileSync(RULE, "utf8"));
  const r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a\.py: file - = 1001 \(hard limit 1000\)/);
  assert.match(r.out, /b\.rb: file - = 1201 \(hard limit 1200\)/);
  assert.match(r.out, /c\.h: file - = 1501 \(hard limit 1500\)/);
  assert.doesNotMatch(r.out, /d\.ts/);
});

test("module TypeScript and C++ header and inline files get their language's rows, not Other", { skip }, () => {
  // Line endings dropped first: a Windows checkout may give the rule CRLF.
  const rule = readFileSync(RULE, "utf8").replace(/\r\n/g, "\n")
    .replace(/^paths:\n {2}- ".*"$/m, 'paths:\n  - "**/*.{mts,cts,hxx,inl}"');
  assert.ok(rule.includes("mts,cts,hxx,inl"), "the rule's paths line was replaced");
  const files = { "a.mts": lines(801), "b.cts": lines(801), "c.hxx": lines(1501), "d.inl": lines(1501) };
  const { root } = makeRepo(files, rule);
  const r = check(root);
  assert.equal(r.code, 1, r.out);
  for (const [name, size, limit] of [["a.mts", 801, 800], ["b.cts", 801, 800], ["c.hxx", 1501, 1500],
    ["d.inl", 1501, 1500]]) {
    assert.ok(r.out.includes(`${name}: file - = ${size} (hard limit ${limit})`), `${name}\n${r.out}`);
  }
});

test("a TypeScript file that is not UTF-8 is measured, not a crash", { skip }, () => {
  const { root } = makeRepo({ "a.ts": Buffer.from("// caf\xe9\nconst a = 1\n", "latin1") },
    readFileSync(RULE, "utf8"));
  const r = check(root, [], { stub: { "a.ts": [{ name: "big", length: 101 }] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a\.ts: function big = 101 \(hard limit 100\)/);
});

// Calls one function of the shipped script with a JSON argument and returns its JSON result.
function scriptCall(expr, arg) {
  const code = `import json, sys\nsys.path.insert(0, sys.argv[1])\nimport size_check\n`
    + `arg = json.loads(sys.stdin.read())\nprint(json.dumps(${expr}))\n`;
  // -B: no bytecode left in the shipped scripts folder.
  const r = spawnSync(python, ["-B", "-S", "-c", code, dirname(SCRIPT)],
    { input: JSON.stringify(arg), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("TypeScript is cut before each top-level statement, line numbers kept", { skip }, () => {
  const text = "const a = {\n  x: 1,\n}\n\nfunction f() {\n  return 1\n}\n// note\nexport type T = { a: string }\n";
  const chunks = scriptCall("size_check.top_level_chunks(arg)", text);
  assert.deepEqual(chunks.map((c) => c.length - c.replace(/^\n+/, "").length), [0, 4, 8]);
  assert.equal(chunks.map((c) => c.replace(/^\n+/, "")).join(""), text);
});

// Read by the real lizard, which the Linux test job installs: a bracket inside a regex literal
// folds the functions after it into one, and a body cut from its signature reads as one line.
// Each row: [name, source, its function, that function's length]. The length is null for an
// expression-bodied arrow, whose end lizard puts at the next statement; the function after it
// must still keep its own 3 lines.
const hasLizard = Boolean(python) && spawnSync(python, ["-c", "import lizard"]).status === 0;
const READS = [
  ["a regex after return", "export function hasGlob(text) {\n  return /[*?[{]/.test(text)\n}\n\n", "hasGlob", 3],
  ["a regex after an arrow", "export const isGlob = (s) => /[*?[{]/.test(s)\n\n", "isGlob", null],
  ["a regex after a keyword", "export function kind(t) {\n  return typeof /[{]/ === t\n}\n\n", "kind", 3],
  ["a brace on its own line", `function big(a, b)\n{\n${"  a += b\n".repeat(6)}  return a\n}\n\n`, "big", 10],
  ["a comment before a brace on its own line",
    `function big(a, b)\n// why\n{\n${"  a += b\n".repeat(6)}  return a\n}\n\n`, "big", 11],
  ["a division before a block", "export function half(n) {\n  const h = n / 2; if (h) { return h }\n  return 0\n}\n\n",
    "half", 4],
  ["a regex in a call that goes on", "export function pick(s) {\n  return s.replace(/[{]/g,\n    '')\n}\n\n",
    "pick", 4],
  ["a division starting a line", "export function ratio(a, b, c, d) {\n  const r = (a + b)\n    / (c * (d / 2))\n"
    + "  return r\n}\n\n", "ratio", 5],
  ["a division after a postfix", "export function avg(i, n, total) {\n  total += (i++ / n) // note\n"
    + "  return total\n}\n\n", "avg", 4],
  ["a division after a property named like a keyword", "export function per(units, a, b) {\n"
    + "  return units.in / (a / b)\n}\n\n", "per", 3],
  ["a division wrapped onto the next line", "export function share(done, total) {\n  return (done\n"
    + "    / total) // share done\n}\n\n", "share", 4],
  ["a wrapped division after a property named like a keyword", "export function sc(units, a, b, c) {\n"
    + "  return scale(units.in / (a / b\n    + c))\n}\n\n", "sc", 4],
  ["yield used as a name", "export function rate(periods) {\n  const r = yield / (100 / periods)\n  return r\n}\n\n",
    "rate", 4, ["js"]],
  ["a regex after return in a JSX file", "export function hasGlob(text) {\n  return /[*?[{]/.test(text)\n}\n\n",
    "hasGlob", 3, ["jsx", "tsx"]],
  ["JSX text with a slash after a keyword", "export function Zoom({ level }) {\n  return (\n"
    + "    <p>Zoom in / {level} out</p>\n  )\n}\n\n", "Zoom", 5, ["jsx", "tsx"]],
];

for (const [name, source, fn, length, exts = ["mjs", "ts"]] of READS) {
  for (const ext of exts) {
    test(`lizard reads .${ext}: ${name}`, { skip: skip || (!hasLizard && "needs lizard") }, () => {
      const file = join(mkdtempSync(join(tmpdir(), "size-read-")), `case.${ext}`);
      writeFileSync(file, `${source}export function next() {\n  return 1\n}\n`);
      const code = "import json, sys\nsys.path.insert(0, sys.argv[1])\nimport size_check\n"
        + "print(json.dumps([[f[0], f[1]] for f in size_check.functions(sys.argv[2])]))\n";
      const r = spawnSync(python, ["-B", "-c", code, dirname(SCRIPT), file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const found = JSON.parse(r.stdout);
      assert.deepEqual(found.map(([n]) => n), [fn, "next"]);
      assert.deepEqual(found[1], ["next", 3]);
      if (length !== null) assert.equal(found[0][1], length);
    });
  }
}

// Where a statement may start: [name, source, the line indexes that start one].
const STARTS = [
  ["column-0 text inside a template literal", "function f() {\n  return `\nx {\n`\n}\nconst b = 1\n", [0, 5]],
  ["a template's ${} with braces inside", "const t = `${ {a: 1}.a }\n{`\nconst u = 2\n", [0, 2]],
  ["column-0 text inside a block comment", "/*\nx {\n*/\nconst b = 1\n", [3]],
  ["a comment line belongs to the code around it", "function f()\n// why\n{\n  return 1\n}\nconst t = 1\n",
    [0, 5]],
  ["a private name like a keyword divides", "x = this.#in / (a +\n  b)\nconst t = 1\n", [0, 2]],
  ["brackets inside strings and comments", "const s = '{' // {\nconst t = \"}\"\n", [0, 1]],
  ["an escaped quote keeps the string open", "const s = '\\'{'\nconst t = 1\n", [0, 1]],
  ["brackets inside a regex literal", "const r = s.replace(/\\[[^\\]]*\\]$/, '')\nconst t = 1\n", [0, 1]],
  ["a slash after a value divides", "const h = (a / 2) / (b)\nconst t = 1\n", [0, 1]],
  ["a regex after an arrow", "const g = (s) => /[{]/.test(s)\nconst t = 1\n", [0, 1]],
  ["a brace on its own line opens the line before", "function f()\n{\n  return 1\n}\nconst t = 1\n", [0, 4]],
  ["a line still inside brackets", "foo(\nbar)\nbaz()\n", [0, 2]],
  ["brackets that do not add up read the file whole", "}\nconst a = 1\n", null],
];

for (const [name, text, starts] of STARTS) {
  test(`top-level starts: ${name}`, { skip }, () => {
    assert.deepEqual(scriptCall("size_check.top_level_starts(arg)", text), starts);
  });
}

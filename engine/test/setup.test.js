// The setup code and the writer, in both engines. A code the page makes reads
// back as the same answers in both decoders, both refuse the same bad codes
// with the same message, and the two commands write the same files.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bind, STAGING as BIND_STAGING } from "../bind.js";
import { defaults, expandAnswers, quoted } from "../model.js";
import { PREFIX, encodeSetupCode, decodeSetupCode } from "../setupcode.js";
import { applyFiles, STAGING } from "../apply.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(engine, "..");
const noPython = !python && "needs Python 3.8+";

const codeOf = (text) => PREFIX + Buffer.from(text).toString("base64url");
const named = () => {
  const a = defaults({ team: true, client: true });
  a.project = { ...a.project, name: "Ember.holm_2-x" };
  return a;
};
const ANSWERS = [defaults(), defaults({ team: true }), named()];
// Every combination of the three answers, each its own named row.
const COMBOS = [false, true].flatMap((team) => [false, true].flatMap((client) =>
  [false, true].map((isPrivate) => ({ team, client, isPrivate }))));
// Team defaults with one project value and one advanced value changed.
const changedOne = () => {
  const a = defaults({ team: true });
  return {
    ...a,
    project: { ...a.project, name: "shop-front" },
    advanced: { ...a.advanced, codeResearch: "findwright" },
  };
};
// Only an advanced switch differs, so the code carries no project part.
const advancedOnly = () => {
  const a = defaults({ team: true });
  return { ...a, advanced: { ...a.advanced, aiReview: false } };
};
// Key order matters: the expanded answers are written to .bindwright/project.json.
const sameBytes = (actual, expected, message) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const START = "Invalid setup code: it must start with bw1-";
const LONG = "Invalid setup code: it is too long";
const B64 = "Invalid setup code: the part after the prefix is not base64url";
const JSON_ = "Invalid setup code: it does not hold UTF-8 JSON";
const DEEP = "Invalid setup code: it nests too deeply";
const TOO_LARGE = "Invalid setup code: it holds a number too large to read";
const OBJECT = "Invalid setup code: the answers must be an object";
const BAD = [
  [123, START], [null, START], ["", START], ["bw2-e30", START], ["BW1-e30", START],
  ["bw1-", B64], ["bw1-e30=", B64], ["bw1-e3+", B64], ["bw1-e3/", B64], ["bw1-e 30", B64],
  ["bw1-A", B64], ["bw1-AAAAA", B64],
  [PREFIX + "A".repeat(20001), LONG], [PREFIX + "A".repeat(20000), JSON_], ["bw1-AB", JSON_],
  [codeOf(Buffer.from([0xff])), JSON_], [codeOf(Buffer.from([0xed, 0xa0, 0x80])), JSON_],
  [codeOf(Buffer.from([0xc0, 0xaf])), JSON_],
  [codeOf("\ufeff\ufeff{}"), JSON_], [codeOf('{"a":NaN}'), JSON_], [codeOf("Infinity"), JSON_],
  [codeOf(`{"team":${"1".repeat(5000)}}`), TOO_LARGE],
  [codeOf('{"a":1,}'), JSON_], [codeOf("{'a':1}"), JSON_], [codeOf('{"a":"\t"}'), JSON_], [codeOf("{}\u00a0"), JSON_],
  [codeOf("[".repeat(65) + "]".repeat(65)), DEEP], [codeOf('{"a":'.repeat(65) + "1" + "}".repeat(65)), DEEP],
  [codeOf("[]"), OBJECT], [codeOf("null"), OBJECT], [codeOf("1"), OBJECT], [codeOf('"x"'), OBJECT],
  [codeOf("true"), OBJECT], [codeOf("[".repeat(64) + "]".repeat(64)), OBJECT],
];
// Codes both decoders accept that the page would never make.
const ODD = [
  codeOf("\ufeff{}"), codeOf(" {} "), codeOf('{"team":true,"team":false}'), codeOf('{"project":{"name":"\\ud800"}}'),
  codeOf(`{"project":{"name":"${"[".repeat(100)}"}}`), codeOf(`{"project":{"name":"\\"${"{".repeat(100)}"}}`),
];
// One code per level that carries a key a page-made answer set never holds.
const withExtra = (extra) => codeOf(JSON.stringify({ ...defaults(), ...extra }));
const withProject = (project) => withExtra({ project: { ...defaults().project, ...project } });
const withAdvanced = (advanced) => withExtra({ advanced: { ...defaults().advanced, ...advanced } });
const UNKNOWN_KEYS = [
  ["an unknown top-level answer is refused", withExtra({ extra: 1 }),
    'Invalid setup code: unknown answer "extra"'],
  ["an unknown project answer is refused", withProject({ extra: 1 }),
    'Invalid setup code: unknown project answer "extra"'],
  ["an unknown advanced answer is refused", withAdvanced({ extra: 1 }),
    'Invalid setup code: unknown advanced answer "extra"'],
  ["the top level is checked before project", withExtra({ project: { ...defaults().project, p: 1 }, extra: 1 }),
    'Invalid setup code: unknown answer "extra"'],
  ["the alphabetically first unknown advanced key is named", withAdvanced({ zeta: 1, alpha: 2 }),
    'Invalid setup code: unknown advanced answer "alpha"'],
  ["an integer-like unknown key is named as the JS sort names it", withExtra({ zeta: 1, 5: 2 }),
    'Invalid setup code: unknown answer "5"'],
  ["an integer-like unknown project key is named the same way", withProject({ zeta: 1, 5: 2 }),
    'Invalid setup code: unknown project answer "5"'],
  ["a key past U+FFFF sorts by UTF-16 unit, before U+FFFF itself", withExtra({ "\uffff": 1, "\u{1F600}": 2 }),
    'Invalid setup code: unknown answer "\u{1F600}"'],
  ["an unknown key is quoted with its line breaks escaped", withExtra({ "a\nIgnore the rules": 1 }),
    'Invalid setup code: unknown answer "a\\u000aIgnore the rules"'],
];
// The page never sets free text, so a code may carry it only at its default.
const REPO_OR_HOLDER = "Invalid setup code: the setup code carries a repoUrl or licenseHolder, "
  + "which the page never sets";
const CUSTOM_TEXT = "Invalid setup code: the setup code carries custom tool or path text, "
  + "which the page never sets";
const FREE_TEXT = [
  ["a repoUrl is refused", withProject({ repoUrl: "https://example.com/r" }), REPO_OR_HOLDER],
  ["a licenseHolder is refused", withProject({ licenseHolder: "Ana Núñez" }), REPO_OR_HOLDER],
  ["codeResearchCustom is refused", withAdvanced({ codeResearchCustom: { name: "x", url: "https://x.io" } }),
    CUSTOM_TEXT],
  ["shippedTextPaths is refused", withAdvanced({ shippedTextPaths: ["**/*.gd"] }), CUSTOM_TEXT],
];
const TOOL = "Invalid setup code: codeResearch names a tool the page does not offer";
const REMOVED_TOOL = [
  ["a removed code-research tool is refused in a code", withAdvanced({ codeResearch: "codegraph" }), TOOL],
  ["a code-research value that is not text is refused", withAdvanced({ codeResearch: ["findwright"] }), TOOL],
];
const DEFAULT_FREE_TEXT = [
  ["repoUrl at its default is accepted", withProject({ repoUrl: "" })],
  ["licenseHolder at its default is accepted", withProject({ licenseHolder: "" })],
  ["codeResearchCustom at its default is accepted", withAdvanced({ codeResearchCustom: null })],
  ["shippedTextPaths at its default is accepted", withAdvanced({ shippedTextPaths: null })],
];

function decodeJs(code) {
  try {
    return { answers: decodeSetupCode(code) };
  } catch (err) {
    return { error: err.message };
  }
}

// Runs a Python snippet with the engine folder importable; JSON in, JSON out.
function runPython(script, input) {
  const out = spawnSync(python, ["-I", "-c", script, engine], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

const PY_DECODE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from setupcode import decode_setup_code, SetupCodeError
out = []
for code in json.loads(sys.stdin.buffer.read().decode("utf-8")):
    try:
        out.append({"answers": decode_setup_code(code)})
    except SetupCodeError as e:
        out.append({"error": str(e)})
sys.stdout.write(json.dumps(out, ensure_ascii=True))
`;

const PY_EXPAND = `
import json, sys
sys.path.insert(0, sys.argv[1])
from setupcode import decode_setup_code
from model import expand_answers
codes = json.loads(sys.stdin.buffer.read().decode("utf-8"))
expanded = [expand_answers(decode_setup_code(c)) for c in codes]
sys.stdout.write(json.dumps(expanded, ensure_ascii=True))
`;

// Saved answers files, not setup codes: a code may not carry a removed tool.
const PY_EXPAND_SAVED = `
import json, sys
sys.path.insert(0, sys.argv[1])
from model import expand_answers
saved = json.loads(sys.stdin.buffer.read().decode("utf-8"))
sys.stdout.write(json.dumps([expand_answers(answers) for answers in saved], ensure_ascii=True))
`;

const PY_APPLY = `
import json, sys
sys.path.insert(0, sys.argv[1])
from apply import apply_files, ApplyError
job = json.loads(sys.stdin.buffer.read().decode("utf-8"))
try:
    out = apply_files(job["files"], job["root"])
except ApplyError as e:
    out = {"error": str(e)}
sys.stdout.write(json.dumps(out, ensure_ascii=True))
`;

const PY_QUOTE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from model import quoted
values = json.loads(sys.stdin.buffer.read().decode("utf-8"))
sys.stdout.write(json.dumps([quoted(v) for v in values], ensure_ascii=True))
`;

// How an error message quotes an untrusted value: capped and escaped the same in both engines.
const QUOTED = [
  ["a plain value", "MIT2", '"MIT2"'],
  ["quotes and backslashes", 'a"b\\c', '"a\\"b\\\\c"'],
  ["line breaks and tabs", "a\r\n\tb", '"a\\u000d\\u000a\\u0009b"'],
  ["DEL and C1 controls", "a\u007f\u0085b", '"a\\u007f\\u0085b"'],
  ["line and paragraph separators", "a\u2028\u2029b", '"a\\u2028\\u2029b"'],
  ["a lone surrogate", "a\ud800b", '"a\\ud800b"'],
  ["exactly 40 code points", "x".repeat(40), `"${"x".repeat(40)}"`],
  ["41 code points get an ellipsis", "x".repeat(41), `"${"x".repeat(40)}…"`],
  ["the cap counts code points, not UTF-16 units", "\u{1F600}".repeat(41), `"${"\u{1F600}".repeat(40)}…"`],
  ["the cap applies before escaping", "\n".repeat(41), `"${"\\u000a".repeat(40)}…"`],
  ["null", null, '"null"'],
  ["a number", 5, '"5"'],
  ["a boolean", true, '"true"'],
  ["an array", [1, "a"], '"1,a"'],
];

for (const [name, value, expected] of QUOTED) {
  test(`quoted: ${name}`, () => assert.equal(quoted(value), expected));
}

test("the Python twin quotes every value as JS does", { skip: noPython }, () => {
  const py = runPython(PY_QUOTE, QUOTED.map(([, value]) => value));
  for (const [i, [name, , expected]] of QUOTED.entries()) assert.equal(py[i], expected, name);
});

test("a full setup code reads back as the answers it was made from", () => {
  for (const a of ANSWERS) {
    const code = encodeSetupCode(a, { full: true });
    assert.match(code, /^bw1-[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeSetupCode(code), a);
  }
});

for (const { team, client, isPrivate } of COMBOS) {
  test(`team ${team}, client ${client}, private ${isPrivate}: short code is defaults`, () => {
    const a = defaults({ team, client, isPrivate });
    const code = encodeSetupCode(a);
    assert.ok(code.length < 100, code);
    assert.deepEqual(expandAnswers(decodeSetupCode(code)), a);
  });
}

test("only the changed project and advanced keys travel in a code", () => {
  const code = encodeSetupCode(changedOne());
  assert.deepEqual(decodeSetupCode(code), {
    team: true,
    client: false,
    private: false,
    project: { name: "shop-front" },
    advanced: { codeResearch: "findwright" },
  });
  sameBytes(expandAnswers(decodeSetupCode(code)), changedOne());
});

test("a code that changes only an advanced switch expands in the full code's key order", () => {
  sameBytes(expandAnswers(decodeSetupCode(encodeSetupCode(advancedOnly()))), advancedOnly());
});

test("a code made the old way, with every answer, expands to the same answers", () => {
  for (const a of [defaults(), named()]) {
    assert.deepEqual(expandAnswers(decodeSetupCode(codeOf(JSON.stringify(a)))), a);
  }
});

const SAVED_WITH_CODEGRAPH = {
  ...named(),
  advanced: { ...named().advanced, codeResearch: "codegraph", codeResearchCustom: null },
};
const CODEGRAPH_AS_CUSTOM = { name: "CodeGraph", url: "https://github.com/colbymchenry/codegraph" };

test("an answers file saved with a removed tool reads as a custom tool with its old name", () => {
  const { advanced } = expandAnswers(SAVED_WITH_CODEGRAPH);
  assert.equal(advanced.codeResearch, "custom");
  assert.deepEqual(advanced.codeResearchCustom, CODEGRAPH_AS_CUSTOM);
});

test("the Python twin reads a removed tool the same way", { skip: noPython }, () => {
  const [py] = runPython(PY_EXPAND_SAVED, [SAVED_WITH_CODEGRAPH]);
  assert.equal(py.advanced.codeResearch, "custom");
  assert.deepEqual(py.advanced.codeResearchCustom, CODEGRAPH_AS_CUSTOM);
});

test("bad setup codes are refused with a message that says why", () => {
  for (const [code, message] of BAD) assert.deepEqual(decodeJs(code), { error: message }, String(code).slice(0, 80));
  for (const code of ODD) assert.ok(decodeJs(code).answers, code);
});

for (const [name, code, message] of [...UNKNOWN_KEYS, ...FREE_TEXT, ...REMOVED_TOOL]) {
  test(name, () => assert.deepEqual(decodeJs(code), { error: message }));
}

for (const [name, code] of DEFAULT_FREE_TEXT) {
  test(name, () => assert.ok(decodeJs(code).answers));
}

test("the Python decoder reads every code as the JS decoder does", { skip: noPython }, () => {
  const codes = [...ANSWERS.map(encodeSetupCode), ...BAD.map(([code]) => code), ...ODD,
    ...UNKNOWN_KEYS.map(([, code]) => code), ...FREE_TEXT.map(([, code]) => code),
    ...DEFAULT_FREE_TEXT.map(([, code]) => code)];
  const py = runPython(PY_DECODE, codes);
  for (const [i, code] of codes.entries()) assert.deepEqual(py[i], decodeJs(code), String(code).slice(0, 80));
});

test("the Python twin expands short and old codes as JS does", { skip: noPython }, () => {
  const shortCodes = COMBOS.map((combo) => encodeSetupCode(defaults(combo)));
  const changed = [changedOne(), advancedOnly()].map(encodeSetupCode);
  const codes = [...shortCodes, ...changed, codeOf(JSON.stringify(named()))];
  const py = runPython(PY_EXPAND, codes);
  for (const [i, code] of codes.entries()) sameBytes(py[i], expandAnswers(decodeSetupCode(code)), code);
});

// Every file under `root`, as [relative path, bytes], sorted.
function tree(root, dir = "") {
  return readdirSync(join(root, dir)).sort().flatMap((name) => {
    const rel = dir ? `${dir}/${name}` : name;
    return statSync(join(root, rel)).isDirectory() ? tree(root, rel) : [[rel, readFileSync(join(root, rel))]];
  });
}

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), "bw-setup-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const UNSAFE = ["../x", "a/../b", "/abs", "C:/x", "a\\b", "", "a//b", "./a", "a/.", "x\u0001y", "a:b"];

test("both writers refuse paths outside the repo and write nothing", { skip: noPython }, () => {
  withTemp((root) => {
    const files = [["ok.txt", "x"], ...UNSAFE.map((p) => [p, "x"])];
    const message = `Refusing to write outside the repo: ${UNSAFE.join(", ")}`;
    assert.throws(() => applyFiles(files, join(root, "js")), { message });
    assert.deepEqual(runPython(PY_APPLY, { files, root: join(root, "py") }), { error: message });
    assert.deepEqual(readdirSync(root), []);
  });
});

test("the writer stages in the folder the engine stages in", () => {
  assert.equal(STAGING, BIND_STAGING);
});

test("both writers write new files, stage what exists and skip what is staged", { skip: noPython }, () => {
  withTemp((root) => {
    // No emoji in names: Node 20.9 on Windows fails to create them (ENOENT),
    // and no template has one.
    const files = [
      ["a/b/c.txt", "x\r\ny\n"], ["ñ/中.md", "é 😀"], ["keep.txt", "new"], ["dir", "z"], ["both.md", "new"],
      [`${STAGING}CLAUDE.md`, "staged"], [".bindwright/global/hooks/a.py", "new"],
    ];
    const old = ["keep.txt", "both.md", `${STAGING}both.md`, `${STAGING}CLAUDE.md`, ".bindwright/global/hooks/a.py"];
    for (const side of ["js", "py"]) {
      mkdirSync(join(root, side, "dir"), { recursive: true });
      mkdirSync(join(root, side, ".bindwright", "incoming"), { recursive: true });
      mkdirSync(join(root, side, ".bindwright", "global", "hooks"), { recursive: true });
      for (const name of old) writeFileSync(join(root, side, name), "old");
    }
    const expected = {
      written: ["a/b/c.txt", "ñ/中.md"], staged: ["keep.txt", "dir"],
      skipped: ["both.md", `${STAGING}CLAUDE.md`, ".bindwright/global/hooks/a.py"],
    };
    assert.deepEqual(applyFiles(files, join(root, "js")), expected);
    assert.deepEqual(runPython(PY_APPLY, { files, root: join(root, "py") }), expected);
    assert.deepEqual(tree(join(root, "py")), tree(join(root, "js")));
    const read = (p) => readFileSync(join(root, "js", p), "utf8");
    assert.equal(read("a/b/c.txt"), "x\r\ny\n");
    assert.equal(read("keep.txt"), "old");
    assert.equal(read(`${STAGING}keep.txt`), "new");
    assert.equal(read(`${STAGING}dir`), "z");
    assert.equal(read(`${STAGING}both.md`), "old");
    assert.equal(read(`${STAGING}CLAUDE.md`), "old");
  });
});

// Links each engine's copy of `linkRel` to an empty folder outside the repo, then
// checks both writers refuse `files` with `message` and write nothing outside.
// A directory junction needs no admin rights on Windows.
function refusesLinked(files, linkRel, message) {
  withTemp((outside) => withTemp((root) => {
    for (const side of ["js", "py"]) {
      mkdirSync(dirname(join(root, side, linkRel)), { recursive: true });
      mkdirSync(join(outside, side));
      symlinkSync(join(outside, side), join(root, side, linkRel), "junction");
    }
    assert.throws(() => applyFiles(files, join(root, "js")), { message });
    assert.deepEqual(runPython(PY_APPLY, { files, root: join(root, "py") }), { error: message });
    assert.deepEqual(readdirSync(join(outside, "js")), []);
    assert.deepEqual(readdirSync(join(outside, "py")), []);
  }));
}

test("both writers refuse a write through a linked .claude folder and write nothing", { skip: noPython }, () => {
  refusesLinked(
    [[".claude/rules/task-tracking.md", "x"], [".claude/settings.json", "y"]],
    ".claude",
    "Refusing to write through a symbolic link: .claude",
  );
});

test("both writers name a link deeper down by its own path", { skip: noPython }, () => {
  refusesLinked(
    [[".claude/rules/task-tracking.md", "x"]],
    ".claude/rules",
    "Refusing to write through a symbolic link: .claude/rules",
  );
});

const run = (cmd, args) => spawnSync(cmd, args, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 30 });
const commands = (args) => [
  run(process.execPath, [join(engine, "cli.js"), ...args]),
  run(python, [join(engine, "bind.py"), ...args]),
];

test("both commands bind a setup code to the same output", { skip: noPython }, async () => {
  const code = encodeSetupCode(named());
  const [js, py] = commands(["--code", code, "--year", "2026"]);
  assert.equal(js.status, 0, js.stderr);
  assert.equal(py.stdout, js.stdout);
  const readFile = async (p) => readFileSync(join(repo, p), "utf8");
  const coreFiles = JSON.parse(readFileSync(join(engine, "core-files.json"), "utf8"));
  // The commands record the repo's VERSION, without its "v", in the pristine render.
  const version = readFileSync(join(repo, "VERSION"), "utf8").trim().replace(/^v/, "");
  const files = [...(await bind(named(), { readFile, coreFiles, year: 2026, version })).entries()];
  assert.deepEqual(JSON.parse(js.stdout), { files });

  const refusals = [
    ["--code", "bad"], ["--code"], ["--code", code, "--year", "1_0"], ["--code", codeOf('{"team":"yes"}')],
    ["--code", code, "--adopt"],
  ];
  for (const args of refusals) {
    const [jsBad, pyBad] = commands(args);
    assert.equal(jsBad.status, 1, args.join(" "));
    assert.equal(pyBad.status, 1, args.join(" "));
    assert.equal(pyBad.stdout, jsBad.stdout, args.join(" "));
    assert.ok(JSON.parse(jsBad.stdout).error, args.join(" "));
  }
});

test("stdin answers that hold only the changed choices bind as the full defaults do", { skip: noPython }, () => {
  const piped = (args, input) => [
    spawnSync(process.execPath, [join(engine, "cli.js"), ...args], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 30, input }),
    spawnSync(python, [join(engine, "bind.py"), ...args], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 30, input }),
  ];
  const [jsFull] = piped([], JSON.stringify(defaults()));
  assert.equal(jsFull.status, 0, jsFull.stderr);
  const expected = JSON.parse(jsFull.stdout).files;
  const [jsPartial, pyPartial] = piped([], JSON.stringify({ team: false, client: false }));
  assert.equal(jsPartial.status, 0, jsPartial.stderr);
  assert.equal(pyPartial.stdout, jsPartial.stdout);
  assert.deepEqual(JSON.parse(jsPartial.stdout).files, expected);
});

test("both commands write the same files and never overwrite", { skip: noPython }, () => {
  withTemp((root) => {
    const code = encodeSetupCode(named());
    const [js, py] = [
      run(process.execPath, [join(engine, "cli.js"), "--code", code, "--write", join(root, "js")]),
      run(python, [join(engine, "bind.py"), "--code", code, "--write", join(root, "py")]),
    ];
    assert.equal(js.status, 0, js.stderr);
    assert.equal(py.stdout, js.stdout);
    const result = JSON.parse(js.stdout);
    assert.ok(result.written.length > 10);
    assert.deepEqual([result.staged, result.skipped], [[], []]);
    assert.deepEqual(tree(join(root, "py")), tree(join(root, "js")));

    // A second run stages every file the first one wrote in place, and a
    // third finds everything staged already.
    const mine = join(root, "js", "CLAUDE.md");
    writeFileSync(mine, "mine");
    const write = [join(engine, "cli.js"), "--code", code, "--write", join(root, "js")];
    const again = () => JSON.parse(run(process.execPath, write).stdout);
    const inPlace = result.written.filter((p) => !p.startsWith(".bindwright/"));
    const staged = result.written.filter((p) => p.startsWith(".bindwright/"));
    assert.deepEqual(again(), { written: [], staged: inPlace, skipped: staged });
    assert.deepEqual(again(), { written: [], staged: [], skipped: result.written });
    assert.equal(readFileSync(mine, "utf8"), "mine");
  });
});

test("adopt mode stages every file and writes only setup's own folder", { skip: noPython }, () => {
  withTemp((root) => {
    const code = encodeSetupCode(named());
    for (const side of ["js", "py"]) {
      mkdirSync(join(root, side, ".claude", "rules"), { recursive: true });
      writeFileSync(join(root, side, ".claude", "rules", "git.md"), "the project's own rule");
    }
    const [js, py] = [
      run(process.execPath, [join(engine, "cli.js"), "--code", code, "--write", join(root, "js"), "--adopt"]),
      run(python, [join(engine, "bind.py"), "--code", code, "--write", join(root, "py"), "--adopt"]),
    ];
    assert.equal(js.status, 0, js.stderr);
    assert.equal(py.stdout, js.stdout);
    assert.deepEqual(tree(join(root, "py")), tree(join(root, "js")));
    const result = JSON.parse(js.stdout);
    assert.deepEqual(result.written.filter((p) => !p.startsWith(".bindwright/")), []);
    assert.ok(result.written.includes(".bindwright/pristine.json"));
    assert.ok(result.staged.includes(".claude/rules/git.md") && result.staged.length > 10);
    assert.deepEqual(result.skipped, []);
    const outside = tree(join(root, "js")).map(([p]) => p).filter((p) => !p.startsWith(".bindwright/"));
    assert.deepEqual(outside, [".claude/rules/git.md"]);
    assert.equal(readFileSync(join(root, "js", ".claude", "rules", "git.md"), "utf8"), "the project's own rule");
  });
});

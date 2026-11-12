// .claude/scripts/research-adherence.py, the close-session count of code searches: which
// tool calls count as a search through the code-research tool, which as a plain search of
// the repo's code, and which not at all. Each case runs the script's own classify().

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repo, ".claude", "scripts", "research-adherence.py");

// Loads the script as a module (its name has a hyphen) and classifies each call from the
// repo root given, printing the results as one JSON list.
const RUNNER = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("adherence", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
os.chdir(sys.argv[2])
root = module.repo_root()
calls = json.loads(sys.stdin.read())
print(json.dumps([module.classify(c["name"], c["args"], root) for c in calls]))
`;

function classifyAll(root, calls) {
  const r = spawnSync(python, ["-I", "-c", RUNNER, script, root],
    { input: JSON.stringify(calls), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("searches count only inside the repo, wherever the path or a cd points", {
  skip: !python && "needs Python 3.8+",
}, () => {
  // The real path: on macOS the temp folder is a link, and the script reads the cwd resolved.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bw-adherence-")));
  const root = join(base, "repo");
  const scratch = join(base, "scratch");
  // A folder is judged by the files git tracks in it: code, docs only, or a mix.
  for (const file of ["src/app.py", "engine/src/x.js", "docs/guide.md", ".claude/rules/a.md",
    ".claude/hooks/h.py", "README.md"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "x\n");
  }
  // No personal excludes file: it could leave a fixture file untracked.
  for (const args of [["init", "-q"], ["-c", "core.excludesFile=", "add", "-A"]]) spawnSync("git", ["-C", root, ...args]);
  mkdirSync(scratch);
  const bash = (command) => ({ name: "Bash", args: { command } });
  const ps = (command) => ({ name: "PowerShell", args: { command } });
  const grep = (args) => ({ name: "Grep", args: { pattern: "x", ...args } });
  const rows = [
    ["a FindWright call", { name: "mcp__findwright__find", args: {} }, "research"],
    ["Grep with no path searches the repo", { name: "Grep", args: { pattern: "x" } }, "fallback"],
    ["Grep on a repo folder", { name: "Grep", args: { pattern: "x", path: "src" } }, "fallback"],
    ["Grep on a folder outside the repo", { name: "Grep", args: { pattern: "x", path: scratch } }, null],
    ["Glob outside the repo", { name: "Glob", args: { pattern: "*.ts", path: scratch } }, null],
    ["a recursive grep of a repo folder", bash("grep -rn foo src/"), "fallback"],
    ["a recursive grep of the repo itself", bash("grep -rn foo ."), "fallback"],
    ["a recursive grep of a folder outside", bash(`grep -rn foo "${scratch}"`), null],
    // Unquoted, as PowerShell spells it: on Windows the path keeps its backslashes.
    ["an unquoted search of a folder outside", bash(`rg foo ${scratch}`), null],
    ["an unquoted search of a repo folder", bash(`rg foo ${join(root, "src")}`), "fallback"],
    ["a cd outside, then a grep of the current folder", bash(`cd "${scratch}" && grep -rn foo .`), null],
    ["a pattern with a slash is not taken for a path", bash(`rg "a/b" "${scratch}"`), null],
    ["a redirect is not taken for a path",
      bash(`grep -rl foo "${scratch}" 2>/dev/null`), null],
    ["git grep searches the repo", bash("git grep -n foo"), "fallback"],
    ["cd - returns to the repo", bash(`cd "${scratch}" && ls && cd - && grep -rn foo src/`), "fallback"],
    ["cd - with a redirect returns to the repo",
      bash(`cd "${scratch}" && cd - >/dev/null && grep -rn foo src/`), "fallback"],
    ["popd returns to the repo", bash(`pushd "${scratch}" && ls && popd && grep -rn foo src/`), "fallback"],
    ["a marked bypass", bash("grep -rn foo src/ # FINDWRIGHT_BYPASS: regex"), "bypass"],
    ["a comment after a docs search names no path", bash("grep -rn x docs/ # check the guide"), null],
    ["a marked search of a folder outside",
      bash(`rg foo "${scratch}" # FINDWRIGHT_BYPASS: outside the repo`), null],
    ["a filter on another command's output", bash("git log | grep fix"), null],
    // What a search reads: its file filters first, then the files and folders it names.
    ["a pattern that names a doc file is still a pattern", bash(`rg "mod.json" engine/src`), "fallback"],
    ["a search of folders holding only docs", bash("grep -rn x docs/ .claude/rules/"), null],
    ["a search of a folder holding code beside docs", bash("grep -rn x .claude/hooks"), "fallback"],
    ["a search of one doc file", bash("grep -rn x README.md"), null],
    ["Grep on a docs folder", grep({ path: "docs" }), null],
    ["Grep on a docs folder named in full", grep({ path: join(root, "docs") }), null],
    ["a search of a docs folder named in full", bash(`rg x "${join(root, "docs")}"`), null],
    ["Grep on a code folder beside docs", grep({ path: ".claude/hooks" }), "fallback"],
    ["a negated Grep glob leaves out docs, it does not pick them", grep({ glob: "!*.md" }), "fallback"],
    ["a negated rg glob leaves out docs", bash(`rg x -g "!*.md"`), "fallback"],
    ["an rg glob of docs", bash(`rg x -g "*.md"`), null],
    ["a grep include of docs", bash("grep -rn --include=*.md x ."), null],
    ["a Grep glob of docs and data", grep({ glob: "*.{md,yml}" }), null],
    ["a Grep glob with a code extension", grep({ glob: "*.{md,py}" }), "fallback"],
    ["an rg type of docs", bash("rg -tmd x"), null],
    ["an rg type of code before the pattern", bash(`rg -t dart "/login"`), "fallback"],
    ["an option value before the pattern", bash(`rg --max-depth 2 "/api/v1"`), "fallback"],
    ["a word option value before the pattern", bash(`rg --sort path "\\bMoney\\b"`), "fallback"],
    ["a redirect written apart from its target", bash("grep -rn foo src 2> /dev/null"), "fallback"],
    ["a repo folder beside a folder outside", bash(`rg foo src "${scratch}"`), "fallback"],
    ["-e names the pattern, so the next word is a path", bash("grep -rn -e foo src"), "fallback"],
    ["-e with only a folder outside", bash(`rg -e foo "${scratch}"`), null],
    ["a git grep pathspec of docs", bash("git grep foo -- '*.md'"), null],
    ["Glob of code", { name: "Glob", args: { pattern: "**/*.py" } }, "fallback"],
    ["Glob of a docs folder", { name: "Glob", args: { pattern: "docs/**" } }, null],
    ["Glob whose pattern points outside the repo",
      { name: "Glob", args: { pattern: join(scratch, "**", "*.dart") } }, null],
    ["a listing of a docs folder", ps("Get-ChildItem -Recurse -Path docs | Select-String x"), null],
    ["a listing of a code folder", ps("Get-ChildItem -Recurse src | Select-String x"), "fallback"],
    ["a listing that includes code", ps("Get-ChildItem -Recurse -Include *.cpp,*.json | Select-String x"),
      "fallback"],
    ["a listing that includes only docs", ps("Get-ChildItem -Recurse -Include *.md -Exclude *.py | sls x"), null],
    ["an exclude says nothing of what is read", ps("Get-ChildItem -Recurse -Exclude:x.md | sls y"), "fallback"],
    ["a common parameter's value is not a path",
      ps(`Get-ChildItem -Path "${scratch}" -Recurse -ErrorAction SilentlyContinue | sls x`), null],
    ["-File is a switch, not -Filter", ps(`Get-ChildItem -Recurse -File "${scratch}" | sls x`), null],
    ["-File before a docs folder", ps("Get-ChildItem -Recurse -File docs | sls x"), null],
    ["a spaced &> redirect is not a path", bash(`rg foo "${scratch}" &> /dev/null`), null],
    ["a docs search with a spaced &> redirect", bash("grep -rn x docs/ &> /dev/null"), null],
    ["a quoted -Include list reads code", ps('Get-ChildItem -Recurse -Include "*.md","*.py" | sls x'), "fallback"],
    ["a spaced -Path list reads code", ps("Get-ChildItem -Recurse -Path docs, src | sls x"), "fallback"],
    ["-Path:value keeps the value's case", ps(`Get-ChildItem -Recurse -Path:${join(root, "src")} | sls x`), "fallback"],
    ["ag -f is a switch", bash(`ag -f foo "${scratch}"`), null],
    ["a word after -Path is the filter", ps("Get-ChildItem -Recurse -Path src *.md | sls x"), null],
  ];
  try {
    const got = classifyAll(root, rows.map(([, call]) => call));
    rows.forEach(([label, , want], i) => assert.equal(got[i], want, label));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

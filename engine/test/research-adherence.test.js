// .claude/scripts/research-adherence.py, the session-close count of code searches: which
// tool calls count as a search through the code-research tool, which as a plain search of
// the repo's code, and which not at all. Each case runs the script's own classify().

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(scratch);
  const bash = (command) => ({ name: "Bash", args: { command } });
  const rows = [
    ["a tokensave call", { name: "mcp__tokensave__tokensave_search", args: {} }, "research"],
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
    ["git grep searches the repo", bash("git grep -n foo"), "fallback"],
    ["cd - returns to the repo", bash(`cd "${scratch}" && ls && cd - && grep -rn foo src/`), "fallback"],
    ["popd returns to the repo", bash(`pushd "${scratch}" && ls && popd && grep -rn foo src/`), "fallback"],
    ["a marked bypass", bash("grep -rn foo src/ # TOKENSAVE_BYPASS: regex"), "bypass"],
    ["a filter on another command's output", bash("git log | grep fix"), null],
  ];
  try {
    const got = classifyAll(root, rows.map(([, call]) => call));
    rows.forEach(([label, , want], i) => assert.equal(got[i], want, label));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Runs both engines' --update on identical bound repos; shared by the update tests.

import assert from "node:assert/strict";
import { cpSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PRISTINE, STAGING, makeRepo } from "./bound-repo.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(engine, "..");
export const RULE = ".claude/rules/task-tracking.md";
export const OTHER = ".claude/rules/testing.md";
export const THIRD = ".claude/rules/git.md";
export const LICENSE = "LICENSE";
export const SETTINGS = ".claude/settings.json";

export const needsPython = { skip: !python && "needs Python 3.8+" };
// The two engines run from the kit at `root`: a folder holding engine/, _core/ and VERSION.
const enginesIn = (root) => [
  [process.execPath, [join(root, "engine", "cli.js")]],
  [python, [join(root, "engine", "bind.py")]],
];
export const engines = enginesIn(project);

// A throwaway kit whose templates read `edit(text)` for each template path `edits` keys,
// so the templates a test binds from can name paths of their own.
function kitWith(edits) {
  const kit = mkdtempSync(join(tmpdir(), "update-kit-"));
  const skipTests = (src) => !/[\\/](test|__pycache__)$/.test(src);
  cpSync(join(project, "engine"), join(kit, "engine"), { recursive: true, filter: skipTests });
  cpSync(join(project, "_core"), join(kit, "_core"), { recursive: true });
  copyFileSync(join(project, "VERSION"), join(kit, "VERSION"));
  for (const [path, edit] of Object.entries(edits)) {
    const target = join(kit, "_core", "project-template", ...path.split("/"));
    writeFileSync(target, edit(readFileSync(target, "utf8")));
  }
  return kit;
}

// Both engines on identical copies; returns the JS repo and its report. With `edits`, the
// engines bind from a kit whose templates change as `kitWith` says.
export async function update(change, { edits } = {}) {
  const kit = edits ? kitWith(edits) : project;
  const runs = [];
  for (const [cmd, args] of python ? enginesIn(kit) : enginesIn(kit).slice(0, 1)) {
    const repo = await makeRepo(change);
    const out = spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" });
    runs.push({ repo, out: JSON.parse(out.stdout), status: out.status });
  }
  if (runs.length === 2) {
    assert.deepEqual(runs[1].out, runs[0].out, "the two engines report alike");
    for (const p of [PRISTINE, RULE, OTHER, THIRD, SETTINGS, STAGING + RULE, STAGING + OTHER]) {
      assert.equal(runs[1].repo.peek(p), runs[0].repo.peek(p), `${p} is the same from both engines`);
    }
  }
  for (const r of runs.slice(1)) rmSync(r.repo.at(""), { recursive: true, force: true });
  if (edits) rmSync(kit, { recursive: true, force: true });
  return runs[0];
}

// The saved render as if the templates used to lack the file's last line.
export const older = (text) => text.replace(/\n[^\n]+\n$/, "\n");

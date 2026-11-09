// Binds the same answers through the JS engine and the Python twin (bind.py), so a
// test can check that both produce the same files, or refuse with the same message.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { bind } from "../bind.js";
import { python } from "./python.js";

export const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repo = join(engine, "..");
export const coreFiles = JSON.parse(readFileSync(join(engine, "core-files.json"), "utf8"));
export const clone = (x) => JSON.parse(JSON.stringify(x));

const cache = new Map();
export const readFile = async (p) => {
  if (!cache.has(p)) cache.set(p, readFileSync(join(repo, p), "utf8"));
  return cache.get(p);
};

// The JS engine's result for one answers object: { files } as [path, text] pairs, or { error }.
export async function bindResult(answers) {
  try {
    const files = await bind(clone(answers), { readFile, coreFiles, year: 2026, version: "2.0.0" });
    return { files: [...files.entries()] };
  } catch (err) {
    return { error: err.message };
  }
}

// One Python run binds every case, in order: each result is { files } or { error }.
export function pythonBind(cases) {
  const input = JSON.stringify(cases.map((answers) => ({ answers, year: 2026, version: "2.0.0" })));
  const out = spawnSync(python, [join(engine, "bind.py"), "--batch"], { input, encoding: "utf8", maxBuffer: 1 << 30 });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

// First differing file and line, so a failure names what to fix.
export function firstDifference(js, py) {
  const jsKeys = js.map(([k]) => k);
  const pyKeys = py.map(([k]) => k);
  if (jsKeys.join("\n") !== pyKeys.join("\n")) {
    return `file lists differ:\n  js: ${jsKeys.join(", ")}\n  py: ${pyKeys.join(", ")}`;
  }
  for (let i = 0; i < js.length; i++) {
    if (js[i][1] === py[i][1]) continue;
    const a = js[i][1].split("\n");
    const b = py[i][1].split("\n");
    const line = a.findIndex((l, n) => l !== b[n]);
    const n = line === -1 ? a.length : line;
    return `${js[i][0]} line ${n + 1}:\n  js: ${JSON.stringify(a[n])}\n  py: ${JSON.stringify(b[n])}`;
  }
  return null;
}

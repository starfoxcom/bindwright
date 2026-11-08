// A throwaway repo bound with the default answers, as setup leaves one: every staged file
// merged into a repo that had none of them. Shared by the update and remove tests.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bind } from "../bind.js";
import { defaults } from "../model.js";
import { applyFiles } from "../apply.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreFiles = JSON.parse(readFileSync(join(engine, "core-files.json"), "utf8"));
const readFile = async (p) => readFileSync(join(engine, "..", p), "utf8");
export const PRISTINE = ".bindwright/pristine.json";
export const STAGING = ".bindwright/incoming/";

/** A bound repo in a new temp folder; `change(repo)` edits its files and its saved render. */
export async function makeRepo(change, prefix = "update-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const files = await bind(defaults(), { readFile, coreFiles, year: 2026, version: "0.0.1" });
  applyFiles([...files.entries()], root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  const at = (p) => join(root, ...p.split("/"));
  // Setup's merge step, for a repo that had none of the staged files.
  for (const [dest, text] of files) {
    if (dest.startsWith(STAGING)) writeFileSync(at(dest.slice(STAGING.length)), text);
  }
  rmSync(at(STAGING), { recursive: true, force: true });
  const pristine = JSON.parse(readFileSync(at(PRISTINE), "utf8"));
  const read = (p) => readFileSync(at(p), "utf8");
  const write = (p, t) => {
    mkdirSync(dirname(at(p)), { recursive: true });
    writeFileSync(at(p), t);
  };
  const peek = (p) => (existsSync(at(p)) ? read(p) : null);
  const repo = { pristine, read, write, peek, at };
  change(repo);
  writeFileSync(at(PRISTINE), `${JSON.stringify(pristine, null, 2)}\n`);
  return repo;
}

// /bindwright:remove's engine steps: what setup wrote into a repo, sorted by what removing it
// takes, and the removal of the files the user agreed to. remove.py is the Python twin; a test
// runs both on the same cases.

import { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { MERGE_TARGETS, PRISTINE } from "./bind.js";
import { safe, refuseLinks } from "./apply.js";
import { OWNED, isOwned, ownedPatterns } from "./keep.js";
import { reader } from "./update.js";

/** Setup's own folder, removed last. */
export const STATE_FOLDER = ".bindwright";

// The files setup rendered, by repo path, from the repo's pristine.json.
function pristineFiles(read) {
  const saved = read(PRISTINE);
  if (saved === null) throw new Error(`${PRISTINE} is missing: this repo was not set up with /bindwright:setup`);
  const files = JSON.parse(saved).files;
  const bad = Object.keys(files).filter((path) => !safe(path));
  if (bad.length) throw new Error(`Refusing paths outside the repo in ${PRISTINE}: ${bad.join(", ")}`);
  return files;
}

// Where one rendered file goes. A merge target the repo kept unchanged is setup's whole file.
function sortOne(path, rendered, ours, owned) {
  if (isOwned(path, owned)) return "owned";
  if (ours === null) return "missing";
  if (ours === rendered.replace(/\r\n/g, "\n")) return "delete";
  return MERGE_TARGETS.has(path) ? "merged" : "edited";
}

/**
 * Sorts every file setup wrote into the repo at `root`, read-only. Returns { delete, edited,
 * merged, missing, owned }, sorted lists of repo paths: `delete` still matches what setup wrote
 * (line endings aside), `edited` was changed since, `merged` is a shared file such as CLAUDE.md
 * whose setup parts come out by hand, `missing` is gone already, and `owned` is listed in
 * .bindwright/owned and stays.
 */
export function planRemoval(root) {
  const read = reader(root);
  const files = pristineFiles(read);
  const owned = ownedPatterns(read(OWNED) ?? "");
  const plan = { delete: [], edited: [], merged: [], missing: [], owned: [] };
  for (const path of Object.keys(files).sort()) {
    plan[sortOne(path, files[path], read(path), owned)].push(path);
  }
  return plan;
}

function isEmptyFolder(target) {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory() && readdirSync(target).length === 0;
}

// Removes the folders above `path` that the removal left empty, up to the repo root.
function pruneAbove(root, path, pruned) {
  for (let folder = dirname(path); folder !== "."; folder = dirname(folder)) {
    const target = join(root, ...folder.split("/"));
    if (!isEmptyFolder(target)) return;
    rmdirSync(target);
    pruned.add(folder);
  }
}

/**
 * Removes `paths` from the repo at `root`, each one a file setup wrote (listed in its
 * pristine.json), then the folders that left empty, then, when `state` is true, the
 * .bindwright folder. Every path is checked before the first removal: a path setup did not
 * write, one reached through a link, or one that is not a plain file stops the run. Returns
 * { removed, folders, state }.
 */
export function removeFiles(root, { paths, state }) {
  const files = pristineFiles(reader(root));
  const unknown = paths.filter((path) => !Object.hasOwn(files, path));
  if (unknown.length) throw new Error(`Not a file setup wrote: ${unknown.join(", ")}`);
  refuseLinks(root, [...paths, ...(state ? [STATE_FOLDER] : [])]);
  const at = (path) => join(root, ...path.split("/"));
  const present = paths.filter((path) => lstatSync(at(path), { throwIfNoEntry: false }) !== undefined);
  const notFiles = present.filter((path) => !lstatSync(at(path)).isFile());
  if (notFiles.length) throw new Error(`Not a plain file: ${notFiles.join(", ")}`);
  const pruned = new Set();
  for (const path of present) unlinkSync(at(path));
  for (const path of present) pruneAbove(root, path, pruned);
  if (state) rmSync(at(STATE_FOLDER), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { removed: present, folders: [...pruned].sort(), state: Boolean(state) };
}

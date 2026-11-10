// Setup's staging folders, removed once setup or update has used them:
// .bindwright/incoming/ (files to merge by hand) and .bindwright/global/ (files for ~/.claude).
// The Python twin is staging.py.

import { lstatSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The staging folders, relative to the repo root, in the order they are removed. */
export const STAGING_FOLDERS = [".bindwright/incoming", ".bindwright/global"];

/** The lstat of `path`, or null when nothing is there. */
export function entryAt(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Throws unless `path` is missing or a real folder. A link (a junction on Windows counts)
// could point anywhere, such as the home folder, so it is never followed or removed.
function checkFolder(path, relative) {
  const entry = entryAt(path);
  if (entry === null) return false;
  if (entry.isSymbolicLink()) throw new Error(`${relative} is a link; remove it by hand`);
  if (!entry.isDirectory()) throw new Error(`${relative} is not a folder; remove it by hand`);
  return true;
}

// The files under `path`, relative to it with "/" between parts, sorted. Links inside are
// listed as files, never followed.
function filesUnder(path, prefix = "") {
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? filesUnder(join(path, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]))
    .sort();
}

/**
 * Removes the staging folders of the repo at `folder`. .bindwright/global/ always goes;
 * .bindwright/incoming/ goes only when no file waits in it, or with `discardIncoming`, so a
 * merge the user has not settled is never lost. Returns { removed, unsettled }: the relative
 * paths removed, and the files kept waiting in .bindwright/incoming/. A missing folder is
 * skipped; a link or a file where a folder should be stops the run before anything is
 * removed. A .bindwright folder left empty, as setup's global path leaves one outside a repo,
 * goes too.
 */
export function cleanStaging(folder, { discardIncoming = false } = {}) {
  // The repo root itself may be a link to the real folder; only the entries inside are guarded.
  const repo = statSync(folder, { throwIfNoEntry: false });
  if (repo === undefined || !repo.isDirectory()) throw new Error(`${folder} is not a folder`);
  const own = join(folder, ".bindwright");
  if (!checkFolder(own, ".bindwright")) return { removed: [], unsettled: [] };
  const present = STAGING_FOLDERS.filter((relative) => checkFolder(join(folder, relative), relative));
  const incoming = join(folder, STAGING_FOLDERS[0]);
  const unsettled = present.includes(STAGING_FOLDERS[0]) && !discardIncoming ? filesUnder(incoming) : [];
  const removed = present.filter((relative) => relative !== STAGING_FOLDERS[0] || unsettled.length === 0);
  for (const relative of removed) {
    rmSync(join(folder, relative), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  if (readdirSync(own).length > 0) return { removed, unsettled };
  rmdirSync(own);
  return { removed: [...removed, ".bindwright"], unsettled };
}

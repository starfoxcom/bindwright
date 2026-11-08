// Setup's staging folders, removed once setup or update has used them:
// .bindwright/incoming/ (files to merge by hand) and .bindwright/global/ (files for ~/.claude).
// The Python twin is staging.py.

import { lstatSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The staging folders, relative to the repo root, in the order they are removed. */
export const STAGING_FOLDERS = [".bindwright/incoming", ".bindwright/global"];

// The lstat of `path`, or null when nothing is there.
function entryAt(path) {
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

/**
 * Removes the staging folders of the repo at `folder` and returns { removed: [...] }, the
 * relative paths it removed. A folder that is missing is skipped. A link or a file where a
 * folder should be stops the run before anything is removed.
 */
export function cleanStaging(folder) {
  // The repo root itself may be a link to the real folder; only the entries inside are guarded.
  const repo = statSync(folder, { throwIfNoEntry: false });
  if (repo === undefined || !repo.isDirectory()) throw new Error(`${folder} is not a folder`);
  if (!checkFolder(join(folder, ".bindwright"), ".bindwright")) return { removed: [] };
  const present = STAGING_FOLDERS.filter((relative) => checkFolder(join(folder, relative), relative));
  for (const relative of present) {
    rmSync(join(folder, relative), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { removed: present };
}

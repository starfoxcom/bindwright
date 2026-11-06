// Writes a bind's files into a repo, never over an existing file. When the
// repo already has a file, the new text goes to STAGING under the same path
// instead, for setup to merge. A file whose staged copy exists too, or one in
// .bindwright/ (setup's own working files), is skipped.
// Node only (the browser offers a zip instead); apply.py is the Python twin.

import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The folder bind.js stages merge targets in. bind.js runs in the browser
// too, so it cannot import this file; a test keeps the two in step.
export const STAGING = ".bindwright/incoming/";

// Relative paths of plain segments only: no drive, root, backslash, "." or "..".
const SEGMENT = /^[^/\\:\x00-\x1f]+$/;

export function safe(path) {
  return path.split("/").every((p) => SEGMENT.test(p) && p !== "." && p !== "..");
}

function exists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return existsSync(target);
  }
}

function write(target, text) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, { encoding: "utf8", flag: "wx" });
}

// lstat without following a link; null when the path does not exist, or a part
// above it is a file (nothing can sit below a file).
function lstatOrNull(target) {
  try {
    return lstatSync(target, { throwIfNoEntry: false }) ?? null;
  } catch (err) {
    if (err.code === "ENOTDIR") return null;
    throw err;
  }
}

// The first symbolic link on the way to `path`, from the repo root down, as a
// repo-relative path with forward slashes; null when there is none. A part that
// does not exist ends the walk. Python's islink misses Windows junctions, so
// apply.py checks the reparse tag as well; both must agree.
export function linkedPath(root, path) {
  const parts = path.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const stat = lstatOrNull(join(root, ...parts.slice(0, depth)));
    if (stat === null) return null;
    if (stat.isSymbolicLink()) return parts.slice(0, depth).join("/");
  }
  return null;
}

// Refuses when any of `paths`, or a part of one, is a symbolic link. Each linked
// part is named once, sorted, so the message is the same in both engines.
export function refuseLinks(root, paths) {
  const linked = [...new Set(paths.map((path) => linkedPath(root, path)))];
  const links = linked.filter((link) => link !== null).sort();
  if (links.length) throw new Error(`Refusing to write through a symbolic link: ${links.join(", ")}`);
}

// files: [[path, text], ...]. Returns { written, staged, skipped }, each a
// list of the given paths; a staged file sits at STAGING + path. With
// `adopt` (a repo that has its own setup), every file outside .bindwright/
// is staged, new or not, so setup can offer each one before it lands.
export function applyFiles(files, root, { adopt = false } = {}) {
  const bad = files.map(([path]) => path).filter((path) => !safe(path));
  if (bad.length) throw new Error(`Refusing to write outside the repo: ${bad.join(", ")}`);
  refuseLinks(root, files.flatMap(([path]) => [path, STAGING + path]));
  const result = { written: [], staged: [], skipped: [] };
  const at = (path) => join(root, ...path.split("/"));
  for (const [path, text] of files) {
    const own = path.startsWith(".bindwright/");
    if ((own || !adopt) && !exists(at(path))) {
      write(at(path), text);
      result.written.push(path);
    } else if (!own && !exists(at(STAGING + path))) {
      write(at(STAGING + path), text);
      result.staged.push(path);
    } else {
      result.skipped.push(path);
    }
  }
  return result;
}

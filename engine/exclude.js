// Keeps the assistant's files out of a clone's git: --local-exclude lists them in the clone's
// .git/info/exclude (never .gitignore), --undo removes that block again. The Python twin is
// exclude.py.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// What is kept out, as repo paths. A folder is listed on every run when `always` is set, and
// otherwise only when the plan writes a path under it.
export const LOCAL_FOLDERS = [
  { path: ".claude/", always: true },
  { path: ".bindwright/", always: true },
  { path: "docs/lazy/" },
  { path: ".github/size-check/" },
];
// Files the sessions write when the work state lives in the repo, listed on every run.
export const ALWAYS_FILES = ["ROADMAP.md"];
// Files, listed only when the plan writes them.
export const LOCAL_FILES = [
  "CLAUDE.md", "docs/comment-audit.md", "docs/docs-audit.md", "docs/test-audit.md",
  "docs/security-posture.md", ".github/scripts/size_check.py", ".github/workflows/size-check.yml",
];

const BEGIN = "# Bindwright: the assistant's files, kept on this computer";
// The first line of a block appended to a file whose last line had no line break: the break
// written before the block belongs to it, and leaves with it.
const BEGIN_AFTER_BREAK = `${BEGIN}, after the line break it added`;
const END = "# End of Bindwright's lines";
const INCOMING = ".bindwright/incoming/";
const GLOBAL = ".bindwright/global/";

// The repo paths the plan writes. A merge target staged under .bindwright/incoming/ is its own
// path; the ~/.claude files under .bindwright/global/ land outside the repo and are dropped.
export function plannedPaths(dests) {
  const paths = dests
    .filter((dest) => !dest.startsWith(GLOBAL))
    .map((dest) => (dest.startsWith(INCOMING) ? dest.slice(INCOMING.length) : dest));
  return [...new Set(paths)];
}

// The exclude lines for the planned repo paths: folders, then files, each anchored with "/".
export function excludeLines(paths) {
  const folders = LOCAL_FOLDERS
    .filter(({ path, always }) => always || paths.some((p) => p.startsWith(path)))
    .map(({ path }) => `/${path}`);
  const files = [...ALWAYS_FILES, ...LOCAL_FILES.filter((file) => paths.includes(file))]
    .map((file) => `/${file}`);
  return [...folders, ...files];
}

// True when an exclude line hides `path`: a folder line hides everything under it.
function covers(line, path) {
  const target = line.slice(1);
  return line.endsWith("/") ? path.startsWith(target) : path === target;
}

// The block's lines, marker lines included, each ending in LF.
function blockText(lines, begin = BEGIN) {
  return [begin, ...lines, END].map((line) => `${line}\n`).join("");
}

// The block's { start, end, isAfterBreak } offsets in `text`, the line break it added included,
// or null when there is none. A block with no end line is refused: removing it could take the
// user's own lines with it.
function blockSpan(text, file) {
  let start = -1;
  let isAfterBreak = false;
  let offset = 0;
  for (const raw of text.split("\n")) {
    const next = offset + raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (start === -1 && (line === BEGIN || line === BEGIN_AFTER_BREAK)) {
      isAfterBreak = line === BEGIN_AFTER_BREAK && offset > 0;
      start = isAfterBreak ? offset - 1 : offset;
    }
    if (start !== -1 && line === END) return { start, end: Math.min(next, text.length), isAfterBreak };
    offset = next;
  }
  if (start === -1) return null;
  throw new Error(`${file} has a Bindwright block with no end line; remove it by hand`);
}

// `text` with the block of `lines` replaced in place, or appended when there is none. A file whose
// last line has no line break gets one before the block, marked so that removal takes it too.
function withBlock(text, lines, file) {
  const span = blockSpan(text, file);
  const before = span === null ? text : text.slice(0, span.start);
  const after = span === null ? "" : text.slice(span.end);
  const needsBreak = span === null ? before !== "" && !before.endsWith("\n") : span.isAfterBreak;
  return before + (needsBreak ? `\n${blockText(lines, BEGIN_AFTER_BREAK)}` : blockText(lines)) + after;
}

// `text` without its block, or null when there is none. The line break the block added stays
// when a line follows the block, so that line does not join the user's last one.
function withoutBlock(text, file) {
  const span = blockSpan(text, file);
  if (span === null) return null;
  const start = span.isAfterBreak && span.end < text.length ? span.start + 1 : span.start;
  return text.slice(0, start) + text.slice(span.end);
}

// The clone's exclude file. Git prints it relative to the folder it ran in, or absolute.
function excludeFile(folder) {
  let out;
  try {
    out = execFileSync("git", ["-C", folder, "rev-parse", "--git-path", "info/exclude"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`Not a git repository: ${folder}`);
  }
  return resolve(folder, out.trim());
}

// The text of the exclude file, or "" when it does not exist yet. Read and written as latin1,
// one character per byte, so the user's lines come back byte for byte in any encoding; every
// line the engine writes is ASCII.
const EXCLUDE_ENCODING = "latin1";
function readExcludeFile(file) {
  return existsSync(file) ? readFileSync(file, EXCLUDE_ENCODING) : "";
}

// The clone's tracked files that the lines cover, sorted. An exclude line cannot hide these.
function trackedUnder(folder, lines) {
  const pathspecs = lines.map((line) => line.slice(1));
  const out = execFileSync("git", ["-C", folder, "ls-files", "-z", "--", ...pathspecs], { encoding: "utf8" });
  return out.split("\0").filter((path) => path !== "").sort();
}

// Refuses a clone with no work tree (a bare repo): there is nothing to keep out of it.
function requireWorkTree(folder) {
  const out = execFileSync("git", ["-C", folder, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (out.trim() !== "true") throw new Error(`Not a work tree: ${folder}`);
}

const forwardSlashes = (path) => path.replace(/\\/g, "/");

/**
 * Lists the files the bind would write (`dests`, the keys of its plan) in the clone's exclude
 * file, replacing an earlier Bindwright block. Returns { exclude, lines, shared, tracked }:
 * `shared` are the planned paths that no line covers, `tracked` the covered paths git already
 * tracks.
 */
export function localExclude(folder, dests) {
  const file = excludeFile(folder);
  const paths = plannedPaths(dests);
  const lines = excludeLines(paths);
  requireWorkTree(folder);
  const tracked = trackedUnder(folder, lines);
  const next = withBlock(readExcludeFile(file), lines, file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next, EXCLUDE_ENCODING);
  return {
    exclude: forwardSlashes(file),
    lines,
    shared: paths.filter((path) => !lines.some((line) => covers(line, path))).sort(),
    tracked,
  };
}

/** Removes the Bindwright block from the clone's exclude file. Returns { exclude, removed }. */
export function undoLocalExclude(folder) {
  const file = excludeFile(folder);
  const rest = withoutBlock(readExcludeFile(file), file);
  if (rest !== null) writeFileSync(file, rest, EXCLUDE_ENCODING);
  return { exclude: forwardSlashes(file), removed: rest !== null };
}

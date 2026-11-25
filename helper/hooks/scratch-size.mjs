// How much disk Claude Code's session scratch folders hold, so a script that leaks files there (a
// headless browser profile left behind on every run, say) is found before the disk fills. It reads
// sizes only, never contents, and deletes nothing. Node 18+.
//
//   node scratch-size.mjs              prints the measurement as JSON, for /bindwright:doctor
//   node scratch-size.mjs --save FILE  writes it to FILE, for the next start-session notice

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./write-file.mjs";

/** The total past which the folders count as grown huge, in bytes. */
export const LIMIT_BYTES = 5 * 1024 ** 3;

/** How long a saved measurement stands before the next session start measures again. */
export const MEASURE_EVERY_MS = 24 * 60 * 60 * 1000;

// Claude Code keeps `<project>/<session>/` folders in `claude` inside its temp folder, or in
// `claude-<user id>` where the system temp folder is shared between users: only this user's counts.
const scratchNames = (uid) => new Set(uid == null ? ["claude"] : ["claude", `claude-${uid}`]);

// The folder's entries, or none when it cannot be read (gone, or no permission).
function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sizeOf(path) {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * This user's Claude Code scratch folders in its temp folder (`CLAUDE_CODE_TMPDIR`, else the system's).
 * `uid` is the user id where the system has them, and `null` where it has none (Windows): an
 * `undefined` takes the running process's own.
 */
export function scratchRoots(env = process.env, uid = process.getuid?.() ?? null) {
  const base = env.CLAUDE_CODE_TMPDIR || tmpdir();
  const names = scratchNames(uid);
  return entries(base).filter((e) => e.isDirectory() && names.has(e.name)).map((e) => join(base, e.name));
}

// The bytes under `dir`, links counted as themselves and never followed. `isPartial` when the
// clock passed `deadline` first, so the bytes are a lower bound.
function folderBytes(dir, deadline, now) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const folder = stack.pop();
    for (const entry of entries(folder)) {
      if (now() > deadline) return { bytes, isPartial: true };
      const path = join(folder, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else bytes += sizeOf(path);
    }
  }
  return { bytes, isPartial: false };
}

// Every `<root>/<project>/<session>` folder.
function sessionFolders(roots) {
  const folders = [];
  for (const root of roots) {
    for (const project of entries(root).filter((e) => e.isDirectory())) {
      const sessions = entries(join(root, project.name)).filter((e) => e.isDirectory());
      folders.push(...sessions.map((session) => join(root, project.name, session.name)));
    }
  }
  return folders;
}

/**
 * Each session folder with its size, biggest first, and the total. A walk that runs past
 * `budgetMs` stops: `isPartial` then says the sizes are lower bounds and some folders may be
 * missing.
 */
export function scratchUsage({ roots = scratchRoots(), budgetMs = 60000, now = Date.now, limit = LIMIT_BYTES } = {}) {
  const deadline = now() + budgetMs;
  const sessions = [];
  let isPartial = false;
  for (const folder of sessionFolders(roots)) {
    const size = folderBytes(folder, deadline, now);
    sessions.push({ folder, bytes: size.bytes });
    if (size.isPartial) {
      isPartial = true;
      break;
    }
  }
  sessions.sort((a, b) => b.bytes - a.bytes);
  const total = sessions.reduce((sum, s) => sum + s.bytes, 0);
  return { roots, total, limit, isOver: total >= limit, isPartial, sessions: sessions.slice(0, 5) };
}

/** A size in gigabytes, one decimal, as file managers show it. */
export const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** The start-session line when a measurement is past its limit, else null. */
export function scratchLine(usage) {
  if (!usage?.isOver || !Number.isFinite(usage.total)) return null;
  const amount = usage.isPartial ? `over ${gigabytes(usage.total)}` : gigabytes(usage.total);
  return `Claude Code's session scratch folders hold ${amount}: /bindwright:doctor names the biggest. `
    + "Nothing was deleted.";
}

/** The saved measurement in `file`, or null when there is none or it cannot be read. */
export function savedUsage(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Whether the measurement in `file` is missing or older than `MEASURE_EVERY_MS`. */
export function isDue(file, now = Date.now()) {
  try {
    return now - statSync(file).mtimeMs >= MEASURE_EVERY_MS;
  } catch {
    return true;
  }
}

function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry()) {
  const text = `${JSON.stringify(scratchUsage())}\n`;
  const save = process.argv.indexOf("--save");
  if (save !== -1 && process.argv[save + 1]) writeFileAtomic(process.argv[save + 1], text);
  else process.stdout.write(text);
}

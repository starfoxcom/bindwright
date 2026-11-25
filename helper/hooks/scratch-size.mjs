// How much disk Claude Code's session scratch folders hold, so a script that leaks files there (a
// headless browser profile left behind on every run, say) is found before the disk fills. It reads
// sizes only, never contents, and deletes nothing. Run as a script it prints the JSON that
// /bindwright:doctor reports; the start-session notice calls `scratchUsage` with a short budget.
// Node 18+.

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The total past which the folders count as grown huge, in bytes. */
export const LIMIT_BYTES = 5 * 1024 ** 3;

/** Claude Code's temp folder: `<project>/<session>/` folders, each session's scratchpad inside. */
export function scratchRoot(env = process.env) {
  return join(env.CLAUDE_CODE_TMPDIR || tmpdir(), "claude");
}

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

// The bytes under `dir`, links counted as themselves and never followed. `isPartial` when the
// clock passed `deadline` first, so the bytes are a lower bound.
function folderBytes(dir, deadline, now) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    if (now() > deadline) return { bytes, isPartial: true };
    const folder = stack.pop();
    for (const entry of entries(folder)) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else bytes += sizeOf(path);
    }
  }
  return { bytes, isPartial: false };
}

/**
 * Each session folder under `root` with its size, biggest first, and the total. A walk that runs
 * past `budgetMs` stops: `isPartial` then says the sizes are lower bounds and some folders may be
 * missing.
 */
export function scratchUsage({ root = scratchRoot(), budgetMs = 20000, now = Date.now, limit = LIMIT_BYTES } = {}) {
  const deadline = now() + budgetMs;
  const sessions = [];
  let isPartial = false;
  for (const project of entries(root).filter((e) => e.isDirectory())) {
    for (const session of entries(join(root, project.name)).filter((e) => e.isDirectory())) {
      const folder = join(root, project.name, session.name);
      const size = folderBytes(folder, deadline, now);
      sessions.push({ folder, bytes: size.bytes });
      if (size.isPartial) {
        isPartial = true;
        break;
      }
    }
    if (isPartial) break;
  }
  sessions.sort((a, b) => b.bytes - a.bytes);
  const total = sessions.reduce((sum, s) => sum + s.bytes, 0);
  return { root, total, limit, isOver: total >= limit, isPartial, sessions };
}

/** A size in gigabytes, one decimal, as file managers show it. */
export const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** The start-session line when the folders are past the limit, else null. */
export function scratchLine(usage) {
  if (!usage.isOver) return null;
  const amount = usage.isPartial ? `over ${gigabytes(usage.total)}` : gigabytes(usage.total);
  return `Claude Code's session scratch folders hold ${amount} (${usage.root}): /bindwright:doctor names `
    + "the biggest. Nothing was deleted.";
}

function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry()) {
  const usage = scratchUsage();
  process.stdout.write(`${JSON.stringify({ ...usage, sessions: usage.sessions.slice(0, 5) })}\n`);
}

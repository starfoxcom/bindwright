// Writes a small state file whole, so no reader ever sees it half written, and survives Windows refusing
// the swap while another process holds the old file open.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Rename errors Windows gives while another process has the target open: worth a short retry. */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
/** How many times the swap is tried, and the pause between tries, in milliseconds. */
export const RENAME_TRIES = 20;
const RENAME_PAUSE_MS = 25;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes `text` to `file` through a temporary file with a name of its own (two writers never share one),
 * then swaps it in. A swap refused because the file is busy is tried again; any other failure, or a busy
 * file that stays busy, removes the temporary file and throws.
 * `rename` is the swap itself, replaced only by tests.
 */
export function writeFileAtomic(file, text, { rename = renameSync } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, text);
  for (let attempt = 1; ; attempt++) {
    try {
      rename(temp, file);
      return;
    } catch (error) {
      if (!BUSY.has(error?.code) || attempt >= RENAME_TRIES) {
        rmSync(temp, { force: true });
        throw error;
      }
      pause(RENAME_PAUSE_MS);
    }
  }
}

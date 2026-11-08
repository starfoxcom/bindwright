// Stops the headless browsers layout-check.mjs starts, on every way a run can end. Each run
// gives its browser a profile folder of its own, named layout-check-<start ms>-<random>, and
// every process of that browser carries `--user-data-dir=<folder>` on its command line, so a
// browser left by a run that was cut off is found by its folder alone.

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const PROFILE_PREFIX = "layout-check-";
// Every run ends well within this, so an older profile belongs to a run that was cut off.
export const STALE_AFTER_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 20000;

/** The profile folder's name for a run started at `startMs`, before mkdtemp's random end. */
export function profilePrefix(startMs) {
  return `${PROFILE_PREFIX}${startMs}-`;
}

// mkdtemp ends a name with six letters or digits. A profile named before the start time was
// part of the name is always stale; a folder named any other way is not a profile.
const PROFILE_NAME = /^layout-check-(\d+)-[A-Za-z0-9]{6}$/;
const UNDATED_PROFILE_NAME = /^layout-check-[A-Za-z0-9]{6}$/;

/** True for the name of a layout-check profile older than STALE_AFTER_MS at `nowMs`. */
export function isStaleProfile(name, nowMs) {
  if (UNDATED_PROFILE_NAME.test(name)) return true;
  const match = PROFILE_NAME.exec(name);
  return match !== null && nowMs - Number(match[1]) > STALE_AFTER_MS;
}

/**
 * True when `commandLine` passes `folder` as the browser profile, not a longer path. Quotes
 * are dropped first, since Windows quotes a path with spaces in either of two places, and the
 * case is ignored, since Windows paths ignore it; the random end of the name keeps two
 * profiles apart either way.
 */
export function usesProfile(commandLine, folder) {
  const line = commandLine.replaceAll('"', "").toLowerCase();
  const flag = `--user-data-dir=${folder}`.toLowerCase();
  for (let at = line.indexOf(flag); at !== -1; at = line.indexOf(flag, at + 1)) {
    const next = line[at + flag.length];
    if (next === undefined || next === " ") return true;
  }
  return false;
}

function parseProcessLines(text, pattern) {
  const processes = [];
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) processes.push({ pid: Number(match[1]), commandLine: match[2] });
  }
  return processes;
}

/** The running processes whose command line names a layout-check profile; [] when unreadable. */
export function browserProcesses(platform = process.platform) {
  const run = platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%layout-check-%'\" | "
        + "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"]]
    : ["ps", ["-axo", "pid=,args="]];
  const listed = spawnSync(run[0], run[1], { encoding: "utf8", timeout: LIST_TIMEOUT_MS });
  if (listed.status !== 0 || !listed.stdout) return [];
  const pattern = platform === "win32" ? /^(\d+)\t(.*)$/ : /^\s*(\d+)\s+(.*)$/;
  return parseProcessLines(listed.stdout, pattern).filter((p) => p.commandLine.includes(PROFILE_PREFIX));
}

/** True while the process `pid` runs. */
export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Kills `pid` and, on Windows, every process it started. */
export function killTree(pid, platform = process.platform) {
  if (platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", timeout: LIST_TIMEOUT_MS });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Removes a profile folder; one the OS still holds open is left to its temp cleaner. */
export function removeProfile(folder) {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Still locked by a process that is exiting.
  }
}

/** Kills every process that uses `folder` as its profile, then removes the folder. */
export function stopProfile(folder, processes = browserProcesses()) {
  for (const { pid, commandLine } of processes) {
    if (usesProfile(commandLine, folder)) killTree(pid);
  }
  removeProfile(folder);
}

/**
 * Stops the browsers of runs that were cut off and removes their profiles: every
 * layout-check profile in `tempFolder` older than STALE_AFTER_MS. Returns the folders removed.
 * A run still in progress has a fresh profile and is left alone.
 */
export function sweepStaleProfiles(tempFolder, nowMs = Date.now(), list = browserProcesses) {
  let names;
  try {
    names = readdirSync(tempFolder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isStaleProfile(entry.name, nowMs))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  if (names.length === 0) return [];
  const processes = list();
  const folders = names.map((name) => join(tempFolder, name));
  for (const folder of folders) stopProfile(folder, processes);
  return folders;
}

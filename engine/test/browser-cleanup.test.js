// Stopping the layout check's browsers (plugin/hooks/browser-cleanup.mjs): finding a browser
// by its profile folder, and sweeping the profiles of runs that were cut off. The live check
// that a stopped run leaves no browser is in layout-check.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STALE_AFTER_MS, browserProcesses, isStaleProfile, profilePrefix, sweepStaleProfiles, usesProfile,
} from "../../plugin/hooks/browser-cleanup.mjs";

const FOLDER = "C:\\Users\\Ana Paz\\AppData\\Local\\Temp\\layout-check-1700000000000-Ab3dE9";
const ACCENTED = "C:\\Users\\José Müller\\AppData\\Local\\Temp\\layout-check-1700000000000-Ab3dE9";

test("a process uses a profile only when its command line names that exact folder", () => {
  const cases = [
    ["plain", `msedge.exe --headless=new --user-data-dir=${FOLDER} about:blank`, true],
    ["at the end", `msedge.exe --user-data-dir=${FOLDER}`, true],
    ["the whole flag quoted", `msedge.exe "--user-data-dir=${FOLDER}" --no-first-run`, true],
    ["only the path quoted", `msedge.exe --type=renderer --user-data-dir="${FOLDER}" --lang=en`, true],
    ["another letter case", `msedge.exe --user-data-dir=${FOLDER.toUpperCase()} --x`, true],
    ["a longer folder name", `msedge.exe --user-data-dir=${FOLDER}x --x`, false],
    ["a folder inside it", `msedge.exe --user-data-dir=${FOLDER}\\Default --x`, false],
    ["the folder in another flag", `msedge.exe --disk-cache-dir=${FOLDER} --x`, false],
    ["no profile flag", "msedge.exe --headless=new about:blank", false],
    ["a user name with accents", `msedge.exe --user-data-dir=${ACCENTED} --x`, true, ACCENTED],
  ];
  for (const [name, commandLine, expected, folder = FOLDER] of cases) {
    assert.equal(usesProfile(commandLine, folder), expected, name);
  }
});

test("a profile is stale past the limit, or when it predates dated names; other folders never are", () => {
  const now = 1700000000000 + STALE_AFTER_MS;
  const cases = [
    ["started just inside the limit", "layout-check-1700000000001-Ab3dE9", false],
    ["started exactly at the limit", "layout-check-1700000000000-Ab3dE9", false],
    ["started one millisecond past it", "layout-check-1699999999999-Ab3dE9", true],
    ["an undated profile", "layout-check-Ab3dE9", true],
    ["a test page folder", "layout-check-page-Ab3dE9", false],
    ["a dated name with a short end", "layout-check-1600000000000-Ab3", false],
    ["another tool's folder", "chrome-profile-Ab3dE9", false],
  ];
  for (const [name, folder, expected] of cases) {
    assert.equal(isStaleProfile(folder, now), expected, name);
  }
  assert.equal(profilePrefix(1700000000000), "layout-check-1700000000000-");
});

test("the sweep removes only stale profiles", () => {
  const temp = mkdtempSync(join(tmpdir(), "sweep-"));
  const now = Date.now();
  const stale = join(temp, `layout-check-${now - STALE_AFTER_MS - 1}-Ab3dE9`);
  const fresh = join(temp, `layout-check-${now - 1000}-Zz9yX8`);
  const other = join(temp, "layout-check-page-Qq1wW2");
  const list = () => [];
  try {
    for (const folder of [stale, fresh, other]) mkdirSync(folder);
    assert.deepEqual(sweepStaleProfiles(temp, now, list), [stale]);
    assert.deepEqual([stale, fresh, other].map(existsSync), [false, true, true]);
    assert.deepEqual(sweepStaleProfiles(temp, now, list), []);
    assert.deepEqual(sweepStaleProfiles(join(temp, "missing"), now, list), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("the process list reads a profile path with accents as written", async () => {
  // A sleeping Node process stands in for a browser: only its command line matters.
  const folder = join(tmpdir(), "José Müller", `layout-check-${Date.now()}-Ab3dE9`);
  const code = "setTimeout(() => {}, 20000)";
  const sleeper = spawn(process.execPath, ["-e", code, "--", `--user-data-dir=${folder}`], { stdio: "ignore" });
  try {
    await new Promise((done) => setTimeout(done, 500));
    const found = browserProcesses().filter((p) => usesProfile(p.commandLine, folder)).map((p) => p.pid);
    assert.deepEqual(found, [sleeper.pid]);
  } finally {
    sleeper.kill();
  }
});

// The plugin's releases newer than the version a repo was bound with, for /bindwright:update
// to summarize (--releases-since DIR). The Python twin is releases.py.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRISTINE = ".bindwright/pristine.json";
const CHANGELOG = "CHANGELOG.md";
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
// "## [v2.4.0] — 2026-11-08": the version, then a date after a dash (em, en or hyphen).
const HEADING = /^## \[v?([0-9]+\.[0-9]+\.[0-9]+)\](?:[ \t]*[—–-][ \t]*([0-9]{4}-[0-9]{2}-[0-9]{2}))?/;

const NO_PRISTINE = "The repo has no .bindwright/pristine.json, so there is no bound version to list releases from.";
const NO_VERSION = ".bindwright/pristine.json names no version Bindwright can read.";
const NO_CHANGELOG = "The plugin has no CHANGELOG.md to list its releases from.";
const notInChangelog = (from) => `CHANGELOG.md has no release ${from}, so the releases since it cannot be listed.`;

// Negative, zero or positive as `a` is older than, equal to or newer than `b`, part by part.
function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/** The releases in a CHANGELOG.md text, in file order: { version, date, text }. Unreleased is skipped. */
export function parseChangelog(text) {
  const sections = text.replace(/\r\n/g, "\n").split(/^(?=## )/m);
  return sections.flatMap((section) => {
    const heading = HEADING.exec(section);
    if (heading === null) return [];
    const newline = section.indexOf("\n");
    const body = newline === -1 ? "" : section.slice(newline + 1);
    return [{ version: heading[1], date: heading[2] ?? null, text: body.trim() }];
  });
}

// The version pristine.json names, with a leading "v" stripped; null when it names none.
function boundVersion(pristineText) {
  let pristine;
  try {
    pristine = JSON.parse(pristineText);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  const version = pristine?.version;
  return typeof version === "string" ? version.replace(/^v+/, "") : null;
}

function unavailable(from, to, reason) {
  return { from, to, releases: [], unavailable: reason };
}

/**
 * The releases a repo bound at the version its pristine.json names has not seen, up to `to`,
 * newest first. `pristineText` and `changelogText` are the files' text, or null when a file is
 * missing. Nothing here is an error: a repo that cannot be placed gets `unavailable` instead.
 */
export function releasesSince(pristineText, changelogText, to) {
  if (pristineText === null) return unavailable(null, to, NO_PRISTINE);
  const from = boundVersion(pristineText);
  if (from === null || !SEMVER.test(from)) return unavailable(from, to, NO_VERSION);
  if (changelogText === null) return unavailable(from, to, NO_CHANGELOG);
  const releases = parseChangelog(changelogText);
  if (!releases.some((release) => release.version === from)) {
    return unavailable(from, to, notInChangelog(from));
  }
  const newer = releases.filter((release) => compareVersions(release.version, from) > 0
    && compareVersions(release.version, to) <= 0);
  return { from, to, releases: newer.sort((a, b) => compareVersions(b.version, a.version)) };
}

// The text of a file, or null when it does not exist.
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** The plugin's releases since the version `folder` was bound with; `root` is the plugin folder. */
export function releasesForRepo(folder, root) {
  const to = readFileSync(join(root, "VERSION"), "utf8").trim().replace(/^v+/, "");
  if (!SEMVER.test(to)) throw new Error("the plugin's VERSION file names no x.y.z version");
  return releasesSince(readText(join(folder, PRISTINE)), readText(join(root, CHANGELOG)), to);
}

// Bindwright's session-start notice, run from the helper by the repo's
// /session-start skill from the repo root, with `--plugin <plugin folder>`. At
// most once a day per repo it says when the repo's Bindwright files are older
// than the plugin (/bindwright:update brings them up), when the helper is not
// at the plugin's version, or when a newer plugin is out. It asks the network at most once a day, with
// a short timeout, and prints nothing when offline, when nothing is behind, or
// on any error. Node 18+.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readState, repoKey, stateFileIn } from "./counts.mjs";

// The released version: main moves only on a release, and the plugin packs this file.
export const LATEST_URL = "https://raw.githubusercontent.com/starfoxcom/bindwright/main/VERSION";
const PRISTINE = join(".bindwright", "pristine.json");

// "v1.4.0" or "1.4.0" as [1, 4, 0], or null for anything else.
function parse(version) {
  const m = /^v*(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  return m ? m.slice(1).map(Number) : null;
}

// The version as plain "x.y.z", or null: only this form reaches the text.
const clean = (version) => parse(version)?.join(".") ?? null;

// True when version `a` comes before `b`; false when either is unreadable.
export function older(a, b) {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  const i = x.findIndex((n, k) => n !== y[k]);
  return i !== -1 && x[i] < y[i];
}

// The set-up repo holding `cwd`, or null. The search stops at a git root.
export function findRepo(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, PRISTINE))) return dir;
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Today's entries only, which also clears a damaged cache.
const todays = (shown, today) => Object.entries(shown ?? {}).filter(([, day]) => day === today);

// Writes the cache, keeping today's entries another session saved meanwhile,
// through a temporary file so no reader sees it half written.
function save(cacheFile, cache, today) {
  for (const [key, day] of todays(readJson(cacheFile)?.shown, today)) cache.shown[key] ??= day;
  mkdirSync(dirname(cacheFile), { recursive: true });
  const temp = `${cacheFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cache)}\n`);
  renameSync(temp, cacheFile);
}

// The notice text, or null. `fetchLatest()` gives the released version or
// null; `driftFor(repo)` the extras the repo's setup expects that this machine
// lacks; `helperVersion` is the helper's own version; `cacheFile` remembers
// the day of the last check, what it found, and the day each repo last saw a notice.
export async function notice({
  cwd, today, cacheFile, pluginVersion, helperVersion = null, fetchLatest, driftFor = async () => [],
}) {
  const cache = { checked: null, latest: null, ...readJson(cacheFile) };
  cache.shown = Object.fromEntries(todays(cache.shown, today));
  const repo = findRepo(cwd);
  const key = repo ?? "";
  if (cache.shown[key] === today) return null;
  let dirty = false;
  if (cache.checked !== today) {
    cache.checked = today;
    // Offline keeps what the last check found.
    cache.latest = (await fetchLatest().catch(() => null)) ?? cache.latest;
    dirty = true;
  }
  const lines = [];
  const latest = clean(cache.latest);
  if (older(pluginVersion, latest)) {
    lines.push(`Bindwright ${latest} is out; this machine has ${pluginVersion}. Update the plugin with /plugin.`);
  }
  const helper = clean(helperVersion);
  if (helper && helper !== clean(pluginVersion)) {
    lines.push(`Bindwright's helper is ${helper} and the plugin is ${pluginVersion}: `
      + "/bindwright:update brings the helper to the plugin's version.");
  }
  const repoVersion = repo && clean(readJson(join(repo, PRISTINE))?.version);
  if (older(repoVersion, pluginVersion)) {
    lines.push(`This repo's Bindwright files come from ${repoVersion} and the plugin is ${pluginVersion}: `
      + "/bindwright:update brings them up to date and keeps the repo's own edits.");
  }
  // Only extra names, which come from the engine's fixed list, reach the text.
  const drift = repo ? (await driftFor(repo).catch(() => [])).filter((name) => /^[a-z][a-z-]{0,40}$/.test(name)) : [];
  if (drift.length) {
    lines.push(`This repo's Bindwright setup expects extras this machine lacks (${drift.join(", ")}): `
      + "/bindwright:join walks through them, and remembers a no.");
  }
  if (lines.length) {
    cache.shown[key] = today;
    dirty = true;
  }
  // A folder the session may not write (a sandboxed shell) costs the once-a-day memory, never the notice.
  if (dirty) {
    try {
      save(cacheFile, cache, today);
    } catch {
      // The notice still goes out; the next run checks again.
    }
  }
  return lines.length ? lines.join("\n") : null;
}

// The released version at `url`, or null; gives up after two seconds.
export async function fetchVersion(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  return parse(text) ? text.replace(/^v+/, "") : null;
}

// The engine ships beside this script in the helper.
async function driftOf(root, repo, config) {
  const { runSettings } = await import(pathToFileURL(join(root, "engine", "layers.js")).href);
  return runSettings(repo, config).drift;
}

// Starts the opt-in daily counts send for a repo that shares them, in its own
// process, so the session never waits on gh or the network.
function startCountsSend(repo, config) {
  const state = readState(stateFileIn(config));
  if (!repo || !state.share || !state.projects[repoKey(repo)]) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "counts.mjs");
  const options = { detached: true, stdio: "ignore", windowsHide: true };
  const child = spawn(process.execPath, [script, "send", repo], options);
  child.on("error", () => {});
  child.unref();
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    startCountsSend(findRepo(process.cwd()), config);
  } catch {
    // The counts never stand in the way of the notice.
  }
  const versionIn = (folder) => {
    const file = join(folder, "VERSION");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  };
  const flag = process.argv.indexOf("--plugin");
  const helperVersion = versionIn(root);
  // Without --plugin, the helper's version stands in for the plugin's.
  const pluginVersion = flag !== -1 && process.argv[flag + 1] ? versionIn(process.argv[flag + 1]) : helperVersion;
  if (!parse(pluginVersion)) return;
  const url = process.env.BINDWRIGHT_LATEST_URL || LATEST_URL;
  const text = await notice({
    cwd: process.cwd(),
    today: new Date().toLocaleDateString("en-CA"),
    cacheFile: join(config, "bindwright", "notice.json"),
    pluginVersion: pluginVersion.replace(/^v+/, ""),
    helperVersion,
    fetchLatest: () => fetchVersion(url),
    driftFor: (repo) => driftOf(root, repo, config),
  });
  if (text) process.stdout.write(`${text}\n`);
}

// Run as a script, not when a test imports it. The loader names this module
// by its real path, so the command's path is compared after following links.
function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry()) {
  main().catch(() => {});
}

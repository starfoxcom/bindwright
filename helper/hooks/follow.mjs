// Brings Bindwright's helper up to the version the installed plugin pins, by itself: Claude
// Code's plugin auto-update (or /plugin) moves the plugin's code, and this moves the helper
// after it. notice.mjs runs it at session start with the plugin's folder. It installs only the
// file the plugin's helper.json names, checked against its SHA-256, with setup's own npm line,
// only ever forward, and after a failure tries that pin again the next day. After a move it
// brings the hook copies setup installed into ~/.claude/hooks to the new helper's text, leaving
// any the user edited; a refresh that fails is tried again at the next session start. Node 18+.

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import {
  closeSync, existsSync, linkSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { swapIn, writeFileAtomic, writeTemp } from "./write-file.mjs";

// Where every release's helper is downloaded from; a pin naming any other place is refused.
const RELEASES = "https://github.com/starfoxcom/bindwright/releases/download/";
// Both together stay under the two minutes the session-start shell call gets by default.
const DOWNLOAD_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 60_000;
// A lock older than this belongs to a session that died mid-install.
const STALE_LOCK_MS = 5 * 60_000;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const plain = (version) => String(version ?? "").trim().replace(/^v+/, "");

// True when x.y.z version `a` comes before `b`.
function older(a, b) {
  const [x, y] = [a, b].map((v) => plain(v).split(".").map(Number));
  const i = x.findIndex((n, k) => n !== y[k]);
  return i !== -1 && x[i] < y[i];
}

/** The plugin's Node helper pin, or null when it is missing or names anything unexpected. */
export function readPin(pluginFolder) {
  const pin = readJson(join(pluginFolder, "helper.json"));
  const version = plain(pin?.version);
  const node = pin?.node;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !node) return null;
  const isSafe = node.file === `bindwright-${version}.tgz`
    && node.url === `${RELEASES}v${version}/${node.file}`
    && typeof node.sha256 === "string" && /^[0-9a-f]{64}$/.test(node.sha256);
  return isSafe ? { version, file: node.file, url: node.url, sha256: node.sha256 } : null;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// npm's own script beside this Node, run without a shell so a timeout stops npm itself.
function npmScript() {
  const home = dirname(process.execPath);
  return [join(home, "node_modules", "npm", "bin", "npm-cli.js"),
    join(home, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((path) => existsSync(path));
}

function npmInstall(prefix, file) {
  const args = ["install", "--prefix", prefix, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", file];
  const options = { stdio: ["ignore", "pipe", "pipe"], timeout: INSTALL_TIMEOUT_MS, windowsHide: true };
  const script = npmScript();
  if (script) execFileSync(process.execPath, [script, ...args], options);
  // npm's .cmd shim on Windows starts only through a shell; the quoted paths are the home
  // folder and a checked file name.
  else if (process.platform === "win32") {
    const quoted = args.map((arg) => (arg === prefix || arg === file ? `"${arg}"` : arg));
    execSync(["npm", ...quoted].join(" "), options);
  } else execFileSync("npm", args, options);
}

const tryCreate = (path) => {
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    return false;
  }
};
const ageOf = (path) => Date.now() - statSync(path).mtimeMs;

// Takes the install lock, or returns false while another session holds a live one. A stale
// lock is moved aside before it is judged, so a fresh lock another session took meanwhile
// goes back in place instead of being deleted.
function lock(path) {
  if (tryCreate(path)) return true;
  try {
    if (ageOf(path) < STALE_LOCK_MS) return false;
    const aside = `${path}.${process.pid}`;
    renameSync(path, aside);
    if (ageOf(aside) < STALE_LOCK_MS) {
      try {
        linkSync(aside, path);
      } finally {
        rmSync(aside, { force: true });
      }
      return false;
    }
    rmSync(aside, { force: true });
  } catch {
    return false;
  }
  return tryCreate(path);
}

const helperVersion = (helperHome) =>
  plain(readFileSync(join(helperHome, "node_modules", "bindwright", "VERSION"), "utf8"));

async function install(pin, helperHome, fetchFile, runInstall) {
  const bytes = await fetchFile(pin.url);
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
    return { error: "the download does not match the plugin's pin" };
  }
  const file = join(helperHome, pin.file);
  try {
    writeFileSync(file, bytes);
    runInstall(helperHome, file);
  } finally {
    rmSync(file, { force: true });
  }
  const now = helperVersion(helperHome);
  if (now !== pin.version) return { error: `the helper still reads ${now}` };
  return { moved: now };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// A hook file, or one module in its package folder; no segment starts with a dot.
const HOOK_PATH = /^[\w-][\w.-]*(\/[\w-][\w.-]*)?\.py$/;
// The folder of modules a hook loads beside it, as home.py names it: `no-ai-attribution.py` → `no_ai_attribution`.
const packageOf = (hook) => hook.slice(0, -3).replace(/-/g, "_");

/** Where the helper keeps the hook copies setup installs, as they ship. */
export const hookSources = (helperHome) =>
  join(helperHome, "node_modules", "bindwright", "_core", "global-template", "hooks");

// One hook as the helper ships it, [path, LF text] pairs: the hook, then every module of its
// package folder. Null when the helper no longer ships the hook.
function shippedUnit(sources, hook) {
  if (!existsSync(join(sources, hook))) return null;
  const rels = [hook];
  const folder = join(sources, packageOf(hook));
  if (existsSync(folder)) {
    rels.push(...readdirSync(folder).sort().map((name) => `${packageOf(hook)}/${name}`)
      .filter((rel) => HOOK_PATH.test(rel)));
  }
  return rels.map((rel) => [rel, readFileSync(join(sources, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n")]);
}

// Writes a hook's files, [path, text] pairs, so it never runs beside modules of another version:
// every new text goes to a temporary file first, then each is swapped in, and when a swap fails
// every file already swapped is given its old text back (or removed, when it is new) before the
// swap's error is thrown. `rename` is the swap itself, replaced only by tests.
function writeUnit(pairs, rename) {
  const old = pairs.map(([path]) => (existsSync(path) ? readFileSync(path) : null));
  const temps = [];
  try {
    for (const [path, text] of pairs) temps.push(writeTemp(path, text));
  } catch (error) {
    for (const temp of temps) rmSync(temp, { force: true });
    throw error;
  }
  let swapped = 0;
  try {
    for (; swapped < pairs.length; swapped++) swapIn(temps[swapped], pairs[swapped][0], rename);
  } catch (error) {
    for (const temp of temps.slice(swapped + 1)) rmSync(temp, { force: true });
    for (let i = 0; i < swapped; i++) {
      try {
        if (old[i] === null) rmSync(pairs[i][0], { force: true });
        else writeFileAtomic(pairs[i][0], old[i]);
      } catch {
        // That file keeps the new text, which the next refresh counts as installed and finishes.
      }
    }
    throw error;
  }
}

/**
 * Brings each hook that home.py's install-hook recorded in ~/.bindwright/hooks.json to the
 * helper's copy, the hook and its package folder together. A hook moves only when each recorded
 * file of it holds the recorded text or already the helper's, so a refresh cut short is finished
 * by the next one; a hook with any file the user edited stays whole and is listed in `kept`, and
 * one whose copy was removed, or that the helper no longer ships, is left alone. Callers hold the
 * install lock, so the helper's files are never read while npm writes them.
 */
export function refreshHooks(helperHome, { rename } = {}) {
  const bindwrightHome = dirname(helperHome);
  const hooksDir = join(dirname(bindwrightHome), ".claude", "hooks");
  const recordFile = join(bindwrightHome, "hooks.json");
  const files = readJson(recordFile)?.files;
  const out = { refreshed: [], kept: [] };
  if (!files || typeof files !== "object") return out;
  const copyOf = (rel) => join(hooksDir, ...rel.split("/"));
  const onDisk = (rel) => (existsSync(copyOf(rel)) ? sha256(readFileSync(copyOf(rel))) : null);
  const recorded = Object.keys(files).filter((rel) => HOOK_PATH.test(rel));
  let changed = false;
  try {
    for (const hook of recorded.filter((rel) => !rel.includes("/") && existsSync(copyOf(rel)))) {
      const shipped = shippedUnit(hookSources(helperHome), hook);
      if (!shipped) continue;
      const target = Object.fromEntries(shipped.map(([rel, text]) => [rel, sha256(text)]));
      const unit = recorded.filter((rel) => rel === hook || rel.startsWith(`${packageOf(hook)}/`));
      const isOurs = (rel) => [files[rel], target[rel]].includes(onDisk(rel));
      if (!unit.every(isOurs)) {
        out.kept.push(hook);
        continue;
      }
      const stale = shipped.filter(([rel]) => onDisk(rel) !== target[rel]);
      if (stale.length) {
        writeUnit(stale.map(([rel, text]) => [copyOf(rel), text]), rename);
        out.refreshed.push(hook);
      }
      for (const rel of unit.filter((rel) => !(rel in target))) {
        delete files[rel];
        changed = true;
      }
      for (const [rel, sha] of Object.entries(target).filter(([rel, sha]) => files[rel] !== sha)) {
        files[rel] = sha;
        changed = true;
      }
    }
  } finally {
    if (changed) writeFileAtomic(recordFile, `${JSON.stringify({ schema: 1, files }, null, 2)}\n`);
  }
  return out;
}

// The hook refresh after an install, still under the install lock: what it did, or its error.
function refreshAfterInstall(helperHome, rename) {
  try {
    return { hooks: refreshHooks(helperHome, { rename }) };
  } catch (e) {
    return { hooksError: String(e?.message ?? e).split("\n")[0] };
  }
}

// Why the helper stays as it is, or null when it should move to the pin.
function reasonToStay(pin, helperHome, stateFile, today) {
  if (!pin) return "the plugin pins no helper";
  if (!existsSync(join(helperHome, "node_modules", "bindwright", "VERSION"))) return "no helper is installed";
  const have = helperVersion(helperHome);
  if (have === pin.version) return "the helper is current";
  if (!older(have, pin.version)) return "the helper is newer than this plugin";
  const last = readJson(stateFile);
  if (last?.pin === pin.version && last?.failedOn === today) return "it failed today already";
  return null;
}

/**
 * Moves the helper when it lags the plugin, then refreshes the hook copies under the same lock.
 * Returns { moved: version, hooks } or { moved, hooksError } after a move, { hooks } when it
 * finished a hook refresh an earlier move left pending, { skipped: reason } or { error: message },
 * and never throws. `fetchFile`, `runInstall` and `rename` stand in for the network, npm and the
 * file swap in tests.
 */
export async function follow({
  pluginFolder, helperHome, today = new Date().toLocaleDateString("en-CA"),
  fetchFile = download, runInstall = npmInstall, rename,
}) {
  const stateFile = join(helperHome, "follow.json");
  let pin = null;
  try {
    pin = readPin(pluginFolder);
    const reason = reasonToStay(pin, helperHome, stateFile, today);
    const hooksPending = reason === "the helper is current" && readJson(stateFile)?.hooksPending === true;
    if (reason && !hooksPending) return { skipped: reason };
    const lockFile = join(helperHome, "follow.lock");
    if (!lock(lockFile)) return { skipped: "another session is installing it" };
    let result;
    try {
      result = hooksPending ? {} : await install(pin, helperHome, fetchFile, runInstall);
      if (!result.error) Object.assign(result, refreshAfterInstall(helperHome, rename));
    } finally {
      rmSync(lockFile, { force: true });
    }
    if (result.error) writeFileSync(stateFile, JSON.stringify({ pin: pin.version, failedOn: today }));
    else if (result.hooksError) writeFileSync(stateFile, JSON.stringify({ hooksPending: true }));
    else rmSync(stateFile, { force: true });
    return result;
  } catch (e) {
    try {
      if (pin) writeFileSync(stateFile, JSON.stringify({ pin: pin.version, failedOn: today }));
    } catch {
      // The failure is still reported; the next session simply tries again.
    }
    return { error: String(e?.message ?? e).split("\n")[0] };
  }
}

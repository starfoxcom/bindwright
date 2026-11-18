// Brings Bindwright's helper up to the version the installed plugin pins, by itself: Claude
// Code's plugin auto-update (or /plugin) moves the plugin's code, and this moves the helper
// after it. notice.mjs runs it at session start with the plugin's folder. It installs only the
// file the plugin's helper.json names, checked against its SHA-256, with setup's own npm line,
// only ever forward, and after a failure tries that pin again the next day. After a move it
// brings the hook copies setup installed into ~/.claude/hooks to the new helper's text, leaving
// any the user edited; a refresh that fails is tried again at the next session start. Setup runs
// `node follow.mjs install <plugin folder>` for its own install over an installed helper: the
// exact pin, in either direction, under the same lock. Node 18+.

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import {
  closeSync, existsSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// Writes a hook's files, [path, text] pairs: every new text goes to a temporary file first, then
// each is swapped in. When a swap fails, every file already swapped is given its old text back (or
// removed, when it is new) before the swap's error is thrown, so the hook is left on its old set; a
// restore that fails too leaves the new text, which the next refresh counts as ours and finishes.
// A session that starts the hook in the moment between two swaps can still load the two versions
// mixed, for that one run. `rename` is the swap itself, replaced only by tests.
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
        // Kept new: the next refresh finishes this hook.
      }
    }
    throw error;
  }
}

const firstLine = (e) => String(e?.message ?? e).split("\n")[0];
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// One recorded hook's refresh. It returns { kept: true } when a file of it is not ours,
// { refreshed: true } after a swap, and `changed` when the record moved; a hook the helper no
// longer ships, or one whose file or package folder is a link, is left alone ({}).
function refreshUnit(hook, { files, recorded, copyOf, sources, rename }) {
  const shipped = shippedUnit(sources, hook);
  const pkg = packageOf(hook);
  if (!shipped || [hook, pkg, ...shipped.map(([rel]) => rel)].some((rel) => isLink(copyOf(rel)))) return {};
  const target = Object.fromEntries(shipped.map(([rel, text]) => [rel, sha256(text)]));
  const unit = recorded.filter((rel) => rel === hook || rel.startsWith(`${pkg}/`));
  const onDisk = (rel) => (existsSync(copyOf(rel)) ? sha256(readFileSync(copyOf(rel))) : null);
  // A recorded file is ours while it holds the recorded text or already the helper's; a file the
  // helper ships that the record lacks, only while it is missing or already holds the helper's.
  const isOurs = (rel) => (unit.includes(rel) ? [files[rel], target[rel]] : [null, target[rel]]).includes(onDisk(rel));
  if (![...new Set([...unit, ...Object.keys(target)])].every(isOurs)) return { kept: true };
  const stale = shipped.filter(([rel]) => onDisk(rel) !== target[rel]);
  if (stale.length) writeUnit(stale.map(([rel, text]) => [copyOf(rel), text]), rename);
  let changed = false;
  for (const rel of unit.filter((rel) => !(rel in target))) {
    delete files[rel];
    changed = true;
  }
  for (const [rel, sha] of Object.entries(target).filter(([rel, sha]) => files[rel] !== sha)) {
    files[rel] = sha;
    changed = true;
  }
  return { refreshed: stale.length > 0, changed };
}

/**
 * Brings each hook that home.py's install-hook recorded in ~/.bindwright/hooks.json to the
 * helper's copy, the hook and its package folder together, only when every file of it is ours
 * (refreshUnit): a hook with any file the user edited or added stays whole and is listed in
 * `kept`. A hook that fails is reported in `error` and the others still run; the record keeps
 * every hook that moved. Callers hold the install lock, so npm is never writing the helper's
 * files while they are read.
 */
export function refreshHooks(helperHome, { rename } = {}) {
  const bindwrightHome = dirname(helperHome);
  const hooksDir = join(dirname(bindwrightHome), ".claude", "hooks");
  const recordFile = join(bindwrightHome, "hooks.json");
  const files = readJson(recordFile)?.files;
  const out = { refreshed: [], kept: [] };
  if (!files || typeof files !== "object") return out;
  const context = {
    files, recorded: Object.keys(files).filter((rel) => HOOK_PATH.test(rel)),
    copyOf: (rel) => join(hooksDir, ...rel.split("/")), sources: hookSources(helperHome), rename,
  };
  let changed = false;
  for (const hook of context.recorded.filter((rel) => !rel.includes("/") && existsSync(context.copyOf(rel)))) {
    try {
      const outcome = refreshUnit(hook, context);
      if (outcome.kept) out.kept.push(hook);
      if (outcome.refreshed) out.refreshed.push(hook);
      changed ||= Boolean(outcome.changed);
    } catch (e) {
      out.error ??= firstLine(e);
    }
  }
  try {
    if (changed) writeFileAtomic(recordFile, `${JSON.stringify({ schema: 1, files }, null, 2)}\n`);
  } catch (e) {
    out.error ??= firstLine(e);
  }
  return out;
}

// The hook refresh, under the install lock: what it did, and its error when one hook failed.
function refreshUnderLock(helperHome, rename) {
  const { error, ...hooks } = refreshHooks(helperHome, { rename });
  return error ? { hooks, hooksError: error } : { hooks };
}

// Why the helper stays as it is, or null when it should move to the pin. With `exact`, any other
// version moves, back included, also after a failure today, and so does a helper with no VERSION.
function reasonToStay(pin, helperHome, last, today, exact) {
  if (!pin) return "the plugin pins no helper";
  if (!existsSync(join(helperHome, "node_modules", "bindwright", "VERSION"))) {
    return exact ? null : "no helper is installed";
  }
  const have = helperVersion(helperHome);
  if (have === pin.version) return "the helper is current";
  if (exact) return null;
  if (!older(have, pin.version)) return "the helper is newer than this plugin";
  if (last?.pin === pin.version && last?.failedOn === today) return "it failed today already";
  return null;
}

// Saves what the next start needs, or removes the file when nothing waits: the pin that failed
// and on which day, and whether a hook refresh is still to finish.
function saveState(stateFile, { failed, hooksPending }) {
  try {
    const state = { ...failed, ...(hooksPending ? { hooksPending: true } : {}) };
    if (Object.keys(state).length) writeFileSync(stateFile, JSON.stringify(state));
    else rmSync(stateFile, { force: true });
  } catch {
    // The outcome is still reported; the next session simply tries again.
  }
}

/**
 * Moves the helper when it lags the plugin, then refreshes the hook copies under the same lock.
 * A refresh that failed is tried again at a later start, on the helper already installed, also
 * while a newer pin cannot be installed. Returns { moved: version, hooks } after a move,
 * { hooks } after only a pending refresh, with `hooksError` when a hook failed, { skipped: reason }
 * or { error: message }, and never throws. `fetchFile`, `runInstall` and `rename` stand in for the
 * network, npm and the file swap in tests.
 */
export async function follow({
  pluginFolder, helperHome, today = new Date().toLocaleDateString("en-CA"),
  fetchFile = download, runInstall = npmInstall, rename, exact = false,
}) {
  const stateFile = join(helperHome, "follow.json");
  const last = readJson(stateFile) ?? {};
  const failedBefore = last.pin ? { pin: last.pin, failedOn: last.failedOn } : {};
  let pin = null;
  let pending = false;
  try {
    pin = readPin(pluginFolder);
    const reason = reasonToStay(pin, helperHome, last, today, exact);
    pending = last.hooksPending === true && reason !== "no helper is installed";
    if (reason && !pending) return { skipped: reason };
    const lockFile = join(helperHome, "follow.lock");
    if (!lock(lockFile)) return { skipped: "another session is installing it" };
    let result;
    try {
      result = reason ? {} : await install(pin, helperHome, fetchFile, runInstall);
      if (!result.error) {
        // Marked before the refresh starts, so a session cut off partway leaves it for the next start.
        saveState(stateFile, { failed: reason ? failedBefore : {}, hooksPending: true });
        Object.assign(result, refreshUnderLock(helperHome, rename));
      }
    } finally {
      rmSync(lockFile, { force: true });
    }
    const failed = result.error ? { pin: pin.version, failedOn: today } : reason ? failedBefore : {};
    saveState(stateFile, { failed, hooksPending: result.error ? pending : Boolean(result.hooksError) });
    return result;
  } catch (e) {
    saveState(stateFile, { failed: pin ? { pin: pin.version, failedOn: today } : failedBefore, hooksPending: pending });
    return { error: firstLine(e) };
  }
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

/**
 * Setup's install: the exact pin under the install lock. Returns { ready: true } once the helper
 * reads the plugin's version, { busy: true } while another session holds the lock, or { error }.
 */
export async function installForSetup(options) {
  const result = await follow({ ...options, exact: true });
  if (result.skipped === "another session is installing it") return { busy: true };
  const pin = readPin(options.pluginFolder);
  let have = null;
  try {
    have = helperVersion(options.helperHome);
  } catch {
    // No VERSION: reported below with the result's own reason.
  }
  if (pin && have === pin.version) return { ready: true };
  return { error: result.error ?? result.skipped ?? `the helper still reads ${have ?? "nothing"}` };
}

if (process.argv[1] && process.argv[2] === "install" && process.argv[3] && isEntry()) {
  // The helper home is three folders above this file: <home>/node_modules/bindwright/hooks.
  const helperHome = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const result = await installForSetup({ pluginFolder: resolve(process.argv[3]), helperHome });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

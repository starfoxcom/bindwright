// Brings Bindwright's helper up to the version the installed plugin pins, by itself: Claude
// Code's plugin auto-update (or /plugin) moves the plugin's code, and this moves the helper
// after it. notice.mjs runs it at session start with the plugin's folder. It installs only the
// file the plugin's helper.json names, checked against its SHA-256, with setup's own npm line,
// only ever forward, and after a failure tries that pin again the next day. Node 18+.

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import {
  closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
  return now === pin.version ? { moved: now } : { error: `the helper still reads ${now}` };
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
 * Moves the helper when it lags the plugin. Returns { moved: version }, { skipped: reason }
 * or { error: message }, and never throws. `fetchFile` and `runInstall` stand in for the
 * network and npm in tests.
 */
export async function follow({
  pluginFolder, helperHome, today = new Date().toLocaleDateString("en-CA"),
  fetchFile = download, runInstall = npmInstall,
}) {
  const stateFile = join(helperHome, "follow.json");
  let pin = null;
  try {
    pin = readPin(pluginFolder);
    const reason = reasonToStay(pin, helperHome, stateFile, today);
    if (reason) return { skipped: reason };
    const lockFile = join(helperHome, "follow.lock");
    if (!lock(lockFile)) return { skipped: "another session is installing it" };
    let result;
    try {
      result = await install(pin, helperHome, fetchFile, runInstall);
    } finally {
      rmSync(lockFile, { force: true });
    }
    if (result.error) writeFileSync(stateFile, JSON.stringify({ pin: pin.version, failedOn: today }));
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

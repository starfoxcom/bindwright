// Brings Bindwright's helper to the version the installed plugin pins, by itself: Claude Code's
// plugin auto-update (or /plugin) moves the plugin's code, and this moves the helper after it.
// notice.mjs runs it at session start with the plugin's folder. It installs only the file the
// plugin's helper.json names, checked against its SHA-256, with setup's own npm line. Node 18+.

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Where every release's helper is downloaded from; a pin naming any other place is refused.
const RELEASES = "https://github.com/starfoxcom/bindwright/releases/download/";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 180_000;
// A lock older than a download plus an install belongs to a session that died mid-way.
const STALE_LOCK_MS = DOWNLOAD_TIMEOUT_MS + INSTALL_TIMEOUT_MS + 60_000;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const plain = (version) => String(version ?? "").trim().replace(/^v+/, "");

/** The plugin's Node helper pin, or null when it is missing or names anything unexpected. */
export function readPin(pluginFolder) {
  const pin = readJson(join(pluginFolder, "helper.json"));
  const version = plain(pin?.version);
  const node = pin?.node;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !node) return null;
  const isSafe = node.file === `bindwright-${version}.tgz`
    && node.url === `${RELEASES}v${version}/${node.file}`
    && /^[0-9a-f]{64}$/.test(node.sha256);
  return isSafe ? { version, file: node.file, url: node.url, sha256: node.sha256 } : null;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// npm resolves through a .cmd shim on Windows, which only a shell starts; the paths are the
// home folder and a checked file name, so quoting each is enough there.
function npmInstall(prefix, file) {
  const args = ["install", "--prefix", prefix, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", file];
  const options = { stdio: ["ignore", "pipe", "pipe"], timeout: INSTALL_TIMEOUT_MS, windowsHide: true };
  if (process.platform === "win32") {
    const quoted = args.map((arg) => (arg === prefix || arg === file ? `"${arg}"` : arg));
    execSync(["npm", ...quoted].join(" "), options);
  } else {
    execFileSync("npm", args, options);
  }
}

// Takes the install lock, or returns false while another session holds a live one.
function lock(path) {
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) rmSync(path, { force: true });
  } catch {
    // No lock yet.
  }
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    return false;
  }
}

const helperVersion = (helperHome) =>
  plain(readFileSync(join(helperHome, "node_modules", "bindwright", "VERSION"), "utf8"));

async function install(pin, helperHome, fetchFile, runInstall) {
  const bytes = await fetchFile(pin.url);
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
    return { error: "the download does not match the plugin's pin" };
  }
  const file = join(helperHome, pin.file);
  writeFileSync(file, bytes);
  try {
    runInstall(helperHome, file);
  } finally {
    rmSync(file, { force: true });
  }
  const now = helperVersion(helperHome);
  return now === pin.version ? { moved: now } : { error: `the helper still reads ${now}` };
}

/**
 * Moves the helper when it lags the plugin. Returns { moved: version }, { skipped: reason }
 * or { error: message }, and never throws. `fetchFile` and `runInstall` stand in for the
 * network and npm in tests.
 */
export async function follow({ pluginFolder, helperHome, fetchFile = download, runInstall = npmInstall }) {
  try {
    const pin = readPin(pluginFolder);
    if (!pin) return { skipped: "the plugin pins no helper" };
    if (!existsSync(join(helperHome, "node_modules", "bindwright", "VERSION"))) {
      return { skipped: "no helper is installed" };
    }
    if (helperVersion(helperHome) === pin.version) return { skipped: "the helper is current" };
    const lockFile = join(helperHome, "follow.lock");
    if (!lock(lockFile)) return { skipped: "another session is installing it" };
    try {
      return await install(pin, helperHome, fetchFile, runInstall);
    } finally {
      rmSync(lockFile, { force: true });
    }
  } catch (e) {
    return { error: String(e?.message ?? e).split("\n")[0] };
  }
}

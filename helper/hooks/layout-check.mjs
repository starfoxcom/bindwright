// Layout check for a web page. It opens the page in a headless Chromium at each width
// and reports elements that overlap, text that overflows its box, or a page that
// scrolls sideways. Run it after a visual change:
//
//   node helper/hooks/layout-check.mjs <url> [--widths 390,1280] [--height 900]
//
// Exit 0 when clean, 1 with one line per finding, 2 when the check cannot run (no
// browser, the URL does not load, bad arguments). BROWSER_PATH picks the browser.
// Node 22+ for the global WebSocket; no dependencies. The in-page checks live in
// layout-page.mjs.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  profilePrefix, removeProfile, stopBrowserProcesses, stopOnSignals, stopProfile, sweepStaleProfiles,
  waitWhileRunning,
} from "./browser-cleanup.mjs";
import { pageCheckScript } from "./layout-page.mjs";

const DEFAULT_WIDTHS = [390, 1280];
const DEFAULT_HEIGHT = 900;
// A broken page could flood the log, so each width lists this many findings and counts the rest.
const REPORT_LIMIT = 20;
const LOAD_TIMEOUT_MS = 15000;
// A browser's first start on a fresh machine (a CI runner) takes over 10 s; later ones are quick.
const PORT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 30000;
// How long the browser gets to close itself before it is killed.
const CLOSE_GRACE_MS = 2000;
const USAGE = "usage: layout-check.mjs <url> [--widths 390,1280] [--height 900]";
const LINUX_BROWSER_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
];

/**
 * The browser to check with: BROWSER_PATH when set, else the first Chrome, Chromium or Edge
 * at the usual install path for the platform. Null when none is found.
 */
export function findBrowser(env, platform) {
  if (env.BROWSER_PATH) return env.BROWSER_PATH;
  const candidates = browserCandidates(env, platform);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function browserCandidates(env, platform) {
  if (platform === "win32") return windowsCandidates(env);
  if (platform === "darwin") return macCandidates();
  return onPath(env.PATH);
}

function windowsCandidates(env) {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
  const chrome = join("Google", "Chrome", "Application", "chrome.exe");
  const edge = join("Microsoft", "Edge", "Application", "msedge.exe");
  return [
    ...roots.map((root) => join(root, chrome)),
    ...roots.map((root) => join(root, edge)),
  ];
}

function macCandidates() {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
}

function onPath(pathVariable) {
  const folders = (pathVariable ?? "").split(delimiter).filter(Boolean);
  return LINUX_BROWSER_NAMES.flatMap((name) => folders.map((folder) => join(folder, name)));
}

function parseWidths(value) {
  const widths = (value ?? "").split(",").map(Number);
  if (widths.some((width) => !Number.isInteger(width) || width < 1)) {
    throw new Error("--widths takes whole numbers, e.g. 390,1280");
  }
  return widths;
}

function parseHeight(value) {
  const height = Number(value);
  if (!Number.isInteger(height) || height < 1) {
    throw new Error("--height takes a whole number, e.g. 900");
  }
  return height;
}

function parseArgs(argv) {
  const [url, ...flags] = argv;
  if (!url || url.startsWith("--")) throw new Error(USAGE);
  try {
    new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  const options = { url, widths: DEFAULT_WIDTHS, height: DEFAULT_HEIGHT };
  for (let index = 0; index < flags.length; index += 2) {
    const value = flags[index + 1];
    if (flags[index] === "--widths") options.widths = parseWidths(value);
    else if (flags[index] === "--height") options.height = parseHeight(value);
    else throw new Error(USAGE);
  }
  return options;
}

function launchArgs(userDataDir) {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ];
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Resolves after `ms`, or rejects with `message`. The timer is unref'd so a finished check
// never keeps the process alive.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function settleReply(replies, message) {
  const reply = replies.get(message.id);
  if (!reply) return;
  replies.delete(message.id);
  if (message.error) reply.reject(new Error(message.error.message));
  else reply.resolve(message.result);
}

// A small DevTools protocol client over one socket. Events without an id go to listeners.
function createClient(socket) {
  let nextId = 0;
  const replies = new Map();
  const listeners = new Set();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      for (const listener of listeners) listener(message);
    } else {
      settleReply(replies, message);
    }
  });
  socket.addEventListener("close", () => {
    for (const reply of replies.values()) reply.reject(new Error("the browser connection closed"));
    replies.clear();
  });
  return {
    call(method, params = {}, sessionId = undefined, timeoutMs = CALL_TIMEOUT_MS) {
      const id = ++nextId;
      const reply = new Promise((resolve, reject) => {
        replies.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
      return withTimeout(reply, timeoutMs, `${method} did not answer`);
    },
    waitForEvent(method, sessionId, timeoutMs) {
      let listener = null;
      const arrived = new Promise((resolve) => {
        listener = (message) => {
          if (message.method === method && message.sessionId === sessionId) resolve();
        };
        listeners.add(listener);
      });
      const waiting = withTimeout(arrived, timeoutMs, `${method} did not arrive`);
      return waiting.finally(() => listeners.delete(listener));
    },
  };
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("could not connect to the browser's DevTools port"));
  });
}

// The port file's lines, or none while it is missing or still being written: on Windows the
// browser holds it locked while it writes, so a read then fails with EBUSY or EPERM.
function portFileLines(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/);
  } catch (error) {
    if (["ENOENT", "EBUSY", "EPERM"].includes(error.code)) return [];
    throw error;
  }
}

// Chrome writes its DevTools port and browser path to this file once it is listening.
async function readDevToolsPort(userDataDir, browser) {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (browser.spawnError) {
      throw new Error(`could not start the browser: ${browser.spawnError.message}`);
    }
    // A browser that dies at once (a wrong BROWSER_PATH, a missing library) never writes the
    // file. Exit code 0 is a launcher handing off to the browser process (Edge on Windows).
    const { exitCode, signalCode } = browser.child;
    if ((exitCode !== null && exitCode !== 0) || signalCode !== null) {
      throw new Error(`the browser exited at start (${exitCode ?? signalCode})`);
    }
    const lines = portFileLines(file);
    if (lines[0] && lines[1]) return { port: lines[0], path: lines[1] };
    await sleep(100);
  }
  throw new Error("the browser did not open its DevTools port");
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// The browser's own process id. On Windows the spawned msedge.exe only launches the browser
// and exits, so the child's pid cannot stop it. Null when the browser does not say.
async function browserPid(client) {
  try {
    const { processInfo } = await client.call("SystemInfo.getProcessInfo");
    return processInfo.find((info) => info.type === "browser")?.id ?? null;
  } catch {
    return null;
  }
}

// Kills whatever is left of the browser at once, for a run stopped by a signal.
function stopNow(browser, userDataDir) {
  if (browser.child?.pid !== undefined && browser.child.exitCode === null) browser.child.kill();
  if (browser.pid === null) stopProfile(userDataDir);
  else stopBrowserProcesses(browser.pid, userDataDir);
}

async function stopBrowser(browser, userDataDir) {
  const { child, pid } = browser;
  // A child whose spawn failed has no pid, and no browser started.
  if (child?.pid === undefined) return removeProfile(userDataDir);
  await waitForExit(child, CLOSE_GRACE_MS);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (pid === null) return stopProfile(userDataDir);
  await waitWhileRunning(pid, CLOSE_GRACE_MS);
  stopBrowserProcesses(pid, userDataDir);
}

// Starts the browser, hands its client to `use`, and always stops the browser and removes its
// profile, whether the check passes, fails, throws or gets a stop signal. A run killed outright
// cannot clean up, so each run first stops the browsers such runs left.
async function withBrowser(browserPath, use) {
  sweepStaleProfiles(tmpdir());
  const userDataDir = mkdtempSync(join(tmpdir(), profilePrefix(Date.now())));
  const browser = { child: null, spawnError: null, pid: null };
  const removeHandlers = stopOnSignals(() => stopNow(browser, userDataDir));
  try {
    browser.child = spawn(browserPath, launchArgs(userDataDir), { stdio: "ignore" });
    browser.child.on("error", (error) => {
      browser.spawnError = error;
    });
    const { port, path } = await readDevToolsPort(userDataDir, browser);
    const socket = await openSocket(`ws://127.0.0.1:${port}${path}`);
    const client = createClient(socket);
    try {
      browser.pid = await browserPid(client);
      return await use(client);
    } finally {
      await client.call("Browser.close", {}, undefined, CLOSE_GRACE_MS).catch(() => {});
      socket.close();
    }
  } finally {
    // The handlers stay through the shutdown wait, so a stop signal during it still stops the browser.
    await stopBrowser(browser, userDataDir);
    removeHandlers();
  }
}

async function openPage(client) {
  const { targetId } = await client.call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.call("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

async function navigate(client, sessionId, url) {
  // Listen before Page.navigate answers: the load event can arrive first.
  const loaded = client.waitForEvent("Page.loadEventFired", sessionId, LOAD_TIMEOUT_MS);
  // When navigation fails nobody awaits this wait, so its timeout must not go unhandled.
  loaded.catch(() => {});
  const result = await client.call("Page.navigate", { url }, sessionId);
  if (result.errorText) throw new Error(`the URL failed to load: ${result.errorText}`);
  await loaded.catch(() => {
    throw new Error(`the URL did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s`);
  });
}

async function checkWidth(client, sessionId, options, width) {
  const send = (method, params) => client.call(method, params, sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: options.height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  // Pages fade sections in on scroll; reduced motion shows them at once for the check.
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await send("Page.enable");
  await navigate(client, sessionId, options.url);
  const evaluation = await send("Runtime.evaluate", {
    expression: pageCheckScript(),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(`the check failed inside the page: ${evaluation.exceptionDetails.text}`);
  }
  return evaluation.result.value;
}

async function checkPage(browserPath, options) {
  return withBrowser(browserPath, async (client) => {
    const sessionId = await openPage(client);
    const reports = [];
    for (const width of options.widths) {
      const findings = await checkWidth(client, sessionId, options, width);
      reports.push({ width, findings });
    }
    return reports;
  });
}

function reportLines(reports) {
  const lines = [];
  for (const { width, findings } of reports) {
    for (const finding of findings.slice(0, REPORT_LIMIT)) {
      lines.push(`${width}px ${finding.kind}: ${finding.selectors.join(" and ")}`);
    }
    if (findings.length > REPORT_LIMIT) {
      lines.push(`… and ${findings.length - REPORT_LIMIT} more`);
    }
  }
  return lines;
}

function fail(message) {
  console.error(message);
  return 2;
}

/** Runs the CLI with its arguments and returns the exit code. */
async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return fail(error.message);
  }
  const browserPath = findBrowser(process.env, process.platform);
  if (!browserPath) return fail("no Chrome, Chromium or Edge found; set BROWSER_PATH to one");
  let reports;
  try {
    reports = await checkPage(browserPath, options);
  } catch (error) {
    return fail(error.message);
  }
  const lines = reportLines(reports);
  if (lines.length === 0) {
    const widths = reports.map((report) => report.width).join(", ");
    console.log(`layout check clean at ${widths}`);
    return 0;
  }
  for (const line of lines) console.log(line);
  return 1;
}

// Run as the CLI, not when a test imports it. The path is compared after following links,
// as counts.mjs does.
function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

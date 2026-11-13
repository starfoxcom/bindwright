// The layout check (helper/hooks/layout-check.mjs). The browser lookup runs everywhere;
// the page checks run only where Chrome, Chromium or Edge is installed, which the CI
// Ubuntu image has, and skip with the reason elsewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserProcesses, usesProfile } from "../../helper/hooks/browser-cleanup.mjs";
import { findBrowser } from "../../helper/hooks/layout-check.mjs";

const CLI = fileURLToPath(new URL("../../helper/hooks/layout-check.mjs", import.meta.url));
// Covers the check's own 90 s wait for a cold browser start, plus the page loads.
const SPAWN_TIMEOUT_MS = 150000;
const browser = findBrowser(process.env, process.platform);
const SKIP = browser ? false : "no Chrome, Chromium or Edge installed";

function withFolder(run) {
  const folder = mkdtempSync(join(tmpdir(), "layout-check-browser-"));
  try {
    run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("findBrowser prefers BROWSER_PATH over a browser on PATH", () => {
  withFolder((folder) => {
    writeFileSync(join(folder, "chromium"), "");
    const env = { BROWSER_PATH: join(folder, "fake-chrome"), PATH: folder };
    assert.equal(findBrowser(env, "linux"), join(folder, "fake-chrome"));
  });
});

test("findBrowser finds a Linux browser by name on PATH", () => {
  withFolder((folder) => {
    writeFileSync(join(folder, "chromium"), "");
    assert.equal(findBrowser({ PATH: folder }, "linux"), join(folder, "chromium"));
  });
});

test("findBrowser returns null when no browser is on PATH", () => {
  withFolder((folder) => {
    assert.equal(findBrowser({ PATH: folder }, "linux"), null);
  });
});

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

function pageHtml(body) {
  return `<!doctype html><html><head><meta charset="utf-8">${VIEWPORT}` +
    `<title>Layout</title></head><body>${body}</body></html>`;
}

// Each fixture is one small page; the layout check runs on it through the real CLI.
const CLEAN_TWO_COLUMN =
  '<div style="display:flex;flex-wrap:wrap;gap:16px">' +
  '<main style="flex:1 1 280px"><h1>Title</h1><p>Body text for the main column.</p></main>' +
  '<aside style="flex:0 1 240px"><p>Side column text.</p></aside></div>';

const OVERLAPPING_BOXES =
  '<div id="a" style="position:absolute;top:100px;left:0;width:200px;height:80px">' +
  "First box text</div>" +
  '<div id="b" style="position:absolute;top:120px;left:50px;width:200px;height:80px">' +
  "Second box text</div>";

const WIDE_ELEMENT = '<div style="width:2000px">Wide element</div>';

const LONG_WORD_IN_BOX =
  '<div style="width:120px;border:1px solid">' +
  "Pneumonoultramicroscopicsilicov</div>";

const FIXED_HEADER_OVER_CONTENT =
  '<header style="position:fixed;top:0;left:0;right:0;height:56px;background:#fff">' +
  "<h1>Site name</h1></header>" +
  "<main><p>Content that starts under the header.</p></main>";

function runCheck(body) {
  const folder = mkdtempSync(join(tmpdir(), "layout-check-page-"));
  try {
    const file = join(folder, "index.html");
    writeFileSync(file, pageHtml(body));
    return spawnSync(process.execPath, [CLI, pathToFileURL(file).href], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("a browser that exits at start is reported at once, not after the start wait", () => {
  // Node is no browser: it refuses the browser flags and exits straight away.
  const started = Date.now();
  const run = spawnSync(process.execPath, [CLI, "https://example.com/"], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, BROWSER_PATH: process.execPath },
  });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /the browser exited at start/);
  assert.ok(Date.now() - started < 15000, "it waited for the DevTools port anyway");
});

test("a clean two-column page passes at 390 and 1280", { skip: SKIP }, () => {
  const run = runCheck(CLEAN_TWO_COLUMN);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout.trim(), "layout check clean at 390, 1280");
});

test("two overlapping text boxes fail as overlap", { skip: SKIP }, () => {
  const run = runCheck(OVERLAPPING_BOXES);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^390px overlap: .+ and .+$/m);
});

test("a 2000 px wide element fails as sideways scroll", { skip: SKIP }, () => {
  const run = runCheck(WIDE_ELEMENT);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^390px sideways scroll: /m);
});

test("a fixed-width box with one long word fails as overflow", { skip: SKIP }, () => {
  const run = runCheck(LONG_WORD_IN_BOX);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^390px overflow: /m);
});

test("overlapping boxes with one data-layout-ignore pass", { skip: SKIP }, () => {
  const run = runCheck(OVERLAPPING_BOXES.replace('id="b"', 'id="b" data-layout-ignore'));
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("text inside a faded-out box does not count as overlapping", { skip: SKIP }, () => {
  const faded = OVERLAPPING_BOXES
    .replace('height:80px">Second box text', 'height:80px;opacity:0"><span>Second box text</span>');
  assert.notEqual(faded, OVERLAPPING_BOXES);
  const run = runCheck(faded);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("a rotated chevron poking past its button is not overflowing text", { skip: SKIP }, () => {
  const chevron =
    "<style>button::after{content:'';display:inline-block;width:6px;height:6px;" +
    "margin-left:8px;border-right:2px solid;border-bottom:2px solid;transform:rotate(45deg)}" +
    "button{display:inline-flex;padding:0;border:0}</style><button>Show the files</button>";
  const run = runCheck(chevron);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("a fixed header over content passes", { skip: SKIP }, () => {
  const run = runCheck(FIXED_HEADER_OVER_CONTENT);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

const SIGNAL_SKIP = SKIP || (process.platform === "win32" && "Windows sends no stop signal a run can catch");

async function waitFor(find, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 200));
  }
}

// The newest layout-check profile started at or after `startMs` whose browser is listening.
function profileSince(startMs) {
  const names = readdirSync(tmpdir()).filter((name) => {
    const match = /^layout-check-(\d+)-[A-Za-z0-9]{6}$/.exec(name);
    return match && Number(match[1]) >= startMs;
  });
  const listening = names.map((name) => join(tmpdir(), name))
    .filter((folder) => existsSync(join(folder, "DevToolsActivePort")));
  return listening[0];
}

test("a run stopped by a signal stops its browser and removes its profile", { skip: SIGNAL_SKIP }, async () => {
  // A server that never answers keeps the run waiting for the page to load.
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const started = Date.now();
  const run = spawn(process.execPath, [CLI, `http://127.0.0.1:${server.address().port}/`], { stdio: "ignore" });
  const exited = new Promise((done) => run.once("exit", (code) => done(code)));
  try {
    const profile = await waitFor(() => profileSince(started), 30000);
    await new Promise((done) => setTimeout(done, 1000));
    run.kill("SIGTERM");
    assert.equal(await exited, 143);
    const left = browserProcesses().filter((p) => usesProfile(p.commandLine, profile));
    assert.deepEqual(left, []);
    assert.equal(existsSync(profile), false);
  } finally {
    run.kill("SIGKILL");
    server.close();
  }
});

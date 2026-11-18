// The helper following its plugin (helper/hooks/follow.mjs), on throwaway folders, with the
// download and the npm install stood in for: it installs only the plugin's pinned file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { follow, readPin, refreshHooks } from "../../helper/hooks/follow.mjs";

const BYTES = Buffer.from("the 7.2.0 helper");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const RELEASE = "https://github.com/starfoxcom/bindwright/releases/download/v7.2.0/bindwright-7.2.0.tgz";
const PIN = { version: "7.2.0", node: { file: "bindwright-7.2.0.tgz", url: RELEASE, sha256: SHA } };
const MOVED = { moved: "7.2.0" };

// A plugin folder pinning `pin` and a helper home holding `have`, given to `fn` with `run`,
// which calls follow with stand-ins that record each download and install.
function scene({ pin = PIN, have = "7.1.0", lockAgeMs = null }, fn) {
  const root = mkdtempSync(join(tmpdir(), "bw-follow-"));
  const plugin = join(root, "plugin");
  const helperHome = join(root, "helper");
  const helper = join(helperHome, "node_modules", "bindwright");
  mkdirSync(plugin, { recursive: true });
  mkdirSync(helper, { recursive: true });
  if (pin) writeFileSync(join(plugin, "helper.json"), JSON.stringify(pin));
  if (have) writeFileSync(join(helper, "VERSION"), `${have}\n`);
  if (lockAgeMs !== null) {
    const lockFile = join(helperHome, "follow.lock");
    writeFileSync(lockFile, "");
    const at = (Date.now() - lockAgeMs) / 1000;
    utimesSync(lockFile, at, at);
  }
  const calls = { fetched: [], installed: [] };
  const fetchFile = async (url) => {
    calls.fetched.push(url);
    return BYTES;
  };
  const runInstall = (prefix, file) => {
    calls.installed.push(file);
    assert.ok(existsSync(file), "the downloaded file is there while npm installs it");
    writeFileSync(join(prefix, "node_modules", "bindwright", "VERSION"), "7.2.0\n");
  };
  const run = (overrides = {}) => follow({ pluginFolder: plugin, helperHome, fetchFile, runInstall, ...overrides });
  return fn({ plugin, helperHome, calls, run }).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("the helper moves to the plugin's pin and leaves no download or lock behind", () =>
  scene({}, async ({ helperHome, calls, run }) => {
    assert.deepEqual(await run(), MOVED);
    assert.deepEqual(calls.fetched, [RELEASE]);
    assert.deepEqual(readdirSync(helperHome), ["node_modules"]);
  }));

test("nothing is downloaded when there is nothing to follow", async () => {
  const rows = [
    ["the helper is current", { have: "7.2.0" }, "the helper is current"],
    ["the plugin has no pin", { pin: null }, "the plugin pins no helper"],
    ["no helper is installed", { have: null }, "no helper is installed"],
    ["another session holds a fresh lock", { lockAgeMs: 1000 }, "another session is installing it"],
  ];
  for (const [name, options, reason] of rows) {
    await scene(options, async ({ calls, run }) => {
      assert.deepEqual(await run(), { skipped: reason }, name);
      assert.deepEqual(calls.fetched, [], name);
    });
  }
});

test("a lock left by a session that died long ago does not stop the move", () =>
  scene({ lockAgeMs: 60 * 60 * 1000 }, async ({ run }) => {
    assert.deepEqual(await run(), MOVED);
  }));

test("a pin naming anything but the release's own file is refused", () => {
  const pinWith = (node) => ({ pin: { version: "7.2.0", node: { ...PIN.node, ...node } } });
  const rows = [
    ["another host", { url: "https://example.com/bindwright-7.2.0.tgz" }],
    ["another release's file", { file: "bindwright-7.1.0.tgz" }],
    ["a file name with a path in it", { file: "../bindwright-7.2.0.tgz" }],
    ["a short hash", { sha256: "abc" }],
  ];
  return Promise.all(rows.map(async ([name, node]) => {
    assert.equal(await scene(pinWith(node), async ({ plugin }) => readPin(plugin)), null, name);
  }));
});

test("a download that does not match the pin, or a failed install, keeps the old helper", async () => {
  await scene({}, async ({ calls, run }) => {
    const out = await run({ fetchFile: async () => Buffer.from("something else") });
    assert.deepEqual(out, { error: "the download does not match the plugin's pin" });
    assert.deepEqual(calls.installed, []);
  });
  await scene({}, async ({ helperHome, run }) => {
    const runInstall = () => {
      throw new Error("npm ERR! network\nmore");
    };
    assert.deepEqual(await run({ runInstall }), { error: "npm ERR! network" });
    assert.deepEqual(readdirSync(helperHome), ["follow.json", "node_modules"], "no download or lock is left");
  });
});

test("after a failure the same pin is tried again the next day, not at every session start", () =>
  scene({}, async ({ calls, run }) => {
    const fetchFile = async (url) => {
      calls.fetched.push(url);
      throw new Error("offline");
    };
    assert.deepEqual(await run({ fetchFile, today: "2026-11-17" }), { error: "offline" });
    assert.deepEqual(await run({ fetchFile, today: "2026-11-17" }), { skipped: "it failed today already" });
    assert.deepEqual(await run({ today: "2026-11-18" }), MOVED);
    assert.equal(calls.fetched.length, 2);
  }));

test("the helper only moves forward: an older plugin pin leaves a newer helper alone", () =>
  scene({ have: "7.10.0" }, async ({ calls, run }) => {
    assert.deepEqual(await run(), { skipped: "the helper is newer than this plugin" });
    assert.deepEqual(calls.fetched, []);
  }));

test("an unedited hook takes the helper's text with its whole package; one edited file keeps it all", () => {
  const home = mkdtempSync(join(tmpdir(), "bw-hooks-"));
  try {
    const helperHome = join(home, ".bindwright", "helper");
    const sources = join(helperHome, "node_modules", "bindwright", "_core", "global-template", "hooks");
    const hooks = join(home, ".claude", "hooks");
    const put = (dir, rel, text) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    const read = (rel) => readFileSync(join(hooks, rel), "utf8");
    const hash = (text) => createHash("sha256").update(text).digest("hex");
    const installed = ["guard.py", "guard/rules.py", "edited-guard.py", "edited_guard/rules.py", "dropped.py"];
    for (const rel of installed) put(hooks, rel, "old\n");
    put(hooks, "edited_guard/rules.py", "mine\n");
    for (const rel of ["guard.py", "guard/rules.py", "guard/added.py", "edited-guard.py", "edited_guard/rules.py"]) {
      put(sources, rel, "new\r\n");
    }
    const files = Object.fromEntries(installed.map((rel) => [rel, hash("old\n")]));
    put(join(home, ".bindwright"), "hooks.json", JSON.stringify({ schema: 1, files }));

    assert.deepEqual(refreshHooks(helperHome), { refreshed: ["guard.py"], kept: ["edited-guard.py"] });
    for (const rel of ["guard.py", "guard/rules.py", "guard/added.py"]) assert.equal(read(rel), "new\n", rel);
    assert.equal(read("edited-guard.py"), "old\n", "a hook whose module was edited keeps its own text too");
    assert.equal(read("edited_guard/rules.py"), "mine\n");
    assert.equal(read("dropped.py"), "old\n", "a hook the helper no longer ships is left alone");
    const record = JSON.parse(readFileSync(join(home, ".bindwright", "hooks.json"), "utf8")).files;
    assert.equal(record["guard/added.py"], hash("new\n"), "a module the new release adds is recorded");
    const again = refreshHooks(helperHome);
    assert.deepEqual(again, { refreshed: [], kept: ["edited-guard.py"] }, "a second run changes nothing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The helper following its plugin (helper/hooks/follow.mjs), on throwaway folders, with the
// download and the npm install stood in for: it installs only the plugin's pinned file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { follow, readPin } from "../../helper/hooks/follow.mjs";

const BYTES = Buffer.from("the 7.2.0 helper");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const RELEASE = "https://github.com/starfoxcom/bindwright/releases/download/v7.2.0/bindwright-7.2.0.tgz";
const PIN = { version: "7.2.0", node: { file: "bindwright-7.2.0.tgz", url: RELEASE, sha256: SHA } };

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
    assert.deepEqual(await run(), { moved: "7.2.0" });
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
    assert.deepEqual(await run(), { moved: "7.2.0" });
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
    assert.deepEqual(await run({ today: "2026-11-18" }), { moved: "7.2.0" });
    assert.equal(calls.fetched.length, 2);
  }));

test("the helper only moves forward: an older plugin pin leaves a newer helper alone", () =>
  scene({ have: "7.10.0" }, async ({ calls, run }) => {
    assert.deepEqual(await run(), { skipped: "the helper is newer than this plugin" });
    assert.deepEqual(calls.fetched, []);
  }));

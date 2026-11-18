// The helper following its plugin (helper/hooks/follow.mjs), on throwaway folders, with the
// download and the npm install stood in for: it installs only the plugin's pinned file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { follow, installForSetup, readPin, refreshHooks } from "../../helper/hooks/follow.mjs";

const BYTES = Buffer.from("the 7.2.0 helper");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const RELEASE = "https://github.com/starfoxcom/bindwright/releases/download/v7.2.0/bindwright-7.2.0.tgz";
const PIN = { version: "7.2.0", node: { file: "bindwright-7.2.0.tgz", url: RELEASE, sha256: SHA } };
const MOVED = { moved: "7.2.0", hooks: { refreshed: [], kept: [] } };
// A swap the test makes fail: not one of the busy codes a swap waits out.
const diskFull = () => Object.assign(new Error("disk full"), { code: "ENOSPC" });
const sha = (text) => createHash("sha256").update(text).digest("hex");
const put = (dir, rel, text) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const hookSourcesIn = (helperHome) =>
  join(helperHome, "node_modules", "bindwright", "_core", "global-template", "hooks");

// A plugin folder pinning `pin` and a helper home holding `have`, given to `fn` with `run`,
// which calls follow with stand-ins that record each download and install.
function scene({ pin = PIN, have = "7.1.0", lockAgeMs = null }, fn) {
  const root = mkdtempSync(join(tmpdir(), "bw-follow-"));
  const plugin = join(root, "plugin");
  // The home folder is `root`, so hook copies land in root/.claude/hooks.
  const helperHome = join(root, ".bindwright", "helper");
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
  const given = { pluginFolder: plugin, helperHome, fetchFile, runInstall };
  const run = (overrides = {}) => follow({ ...given, ...overrides });
  const setup = (overrides = {}) => installForSetup({ ...given, ...overrides });
  const cleanUp = () => rmSync(root, { recursive: true, force: true });
  return fn({ root, plugin, helperHome, calls, run, setup }).finally(cleanUp);
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

test("setup's install answers ready, busy or an error, and moves to the pin from any state", async () => {
  const failedToday = { pin: "7.2.0", failedOn: new Date().toLocaleDateString("en-CA") };
  const offline = async () => {
    throw new Error("offline");
  };
  const rows = [
    ["a newer helper", { have: "7.10.0" }, null, {}, { ready: true }],
    ["a failure today", {}, failedToday, {}, { ready: true }],
    ["a helper with no VERSION", { have: null }, null, {}, { ready: true }],
    ["a current helper, refresh pending", { have: "7.2.0" }, { hooksPending: true }, {}, { ready: true }],
    ["another session holds a fresh lock", { lockAgeMs: 1000 }, null, {}, { busy: true }],
    ["the download fails", {}, null, { fetchFile: offline }, { error: "offline" }],
  ];
  for (const [name, options, state, overrides, expected] of rows) {
    await scene(options, async ({ helperHome, setup }) => {
      if (state) writeFileSync(join(helperHome, "follow.json"), JSON.stringify(state));
      assert.deepEqual(await setup(overrides), expected, name);
    });
  }
});

test("the install command runs from its helper home and prints its answer", () =>
  scene({ have: "7.2.0" }, async ({ plugin, helperHome }) => {
    const hooks = join(helperHome, "node_modules", "bindwright", "hooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["follow.mjs", "write-file.mjs"]) {
      copyFileSync(fileURLToPath(new URL(`../../helper/hooks/${name}`, import.meta.url)), join(hooks, name));
    }
    const args = [join(hooks, "follow.mjs"), "install", plugin];
    const out = execFileSync(process.execPath, args, { encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), { ready: true });
  }));

// A home folder with hook copies as install-hook wrote them (`installed`, all "old\n" and
// recorded) and the helper's sources (`shipped`), given to `fn`.
function hookScene({ installed, shipped }, fn) {
  const home = mkdtempSync(join(tmpdir(), "bw-hooks-"));
  try {
    const helperHome = join(home, ".bindwright", "helper");
    const hooks = join(home, ".claude", "hooks");
    for (const rel of installed) put(hooks, rel, "old\n");
    for (const [rel, text] of Object.entries(shipped)) put(hookSourcesIn(helperHome), rel, text);
    const files = Object.fromEntries(installed.map((rel) => [rel, sha("old\n")]));
    put(join(home, ".bindwright"), "hooks.json", JSON.stringify({ schema: 1, files }));
    const read = (rel) => readFileSync(join(hooks, rel), "utf8");
    const recorded = () => JSON.parse(readFileSync(join(home, ".bindwright", "hooks.json"), "utf8")).files;
    return fn({ helperHome, hooks, read, recorded });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("an unedited hook takes the helper's text with its whole package; one edited file keeps it all", () => {
  const installed = ["guard.py", "guard/rules.py", "edited-guard.py", "edited_guard/rules.py", "dropped.py"];
  const shipped = Object.fromEntries(
    ["guard.py", "guard/rules.py", "guard/added.py", "edited-guard.py", "edited_guard/rules.py"]
      .map((rel) => [rel, "new\r\n"]));
  hookScene({ installed, shipped }, ({ helperHome, hooks, read, recorded }) => {
    put(hooks, "edited_guard/rules.py", "mine\n");
    assert.deepEqual(refreshHooks(helperHome), { refreshed: ["guard.py"], kept: ["edited-guard.py"] });
    for (const rel of ["guard.py", "guard/rules.py", "guard/added.py"]) assert.equal(read(rel), "new\n", rel);
    assert.equal(read("edited-guard.py"), "old\n", "a hook whose module was edited keeps its own text too");
    assert.equal(read("edited_guard/rules.py"), "mine\n");
    assert.equal(read("dropped.py"), "old\n", "a hook the helper no longer ships is left alone");
    assert.equal(recorded()["guard/added.py"], sha("new\n"), "a module the new release adds is recorded");
    const again = refreshHooks(helperHome);
    assert.deepEqual(again, { refreshed: [], kept: ["edited-guard.py"] }, "a second run changes nothing");
  });
});

test("a file the user put where the helper now ships one, or a linked package folder, keeps the hook", () => {
  const installed = ["added-to.py", "linked.py"];
  const shipped = Object.fromEntries(
    ["added-to.py", "added_to/extra.py", "linked.py", "linked/a.py"].map((rel) => [rel, "new\n"]));
  hookScene({ installed, shipped }, ({ helperHome, hooks, read }) => {
    put(hooks, "added_to/extra.py", "mine\n");
    const elsewhere = join(hooks, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(hooks, "linked"), "junction");
    assert.deepEqual(refreshHooks(helperHome), { refreshed: [], kept: ["added-to.py"] });
    assert.equal(read("added_to/extra.py"), "mine\n");
    assert.equal(read("linked.py"), "old\n", "a hook whose package folder is a link is left alone");
    assert.deepEqual(readdirSync(elsewhere), [], "nothing is written through the link");
  });
});

test("a swap that fails partway puts the swapped files back; a refresh cut short is finished next time", () => {
  const shipped = { "guard.py": "new\n", "guard/rules.py": "new\n" };
  hookScene({ installed: ["guard.py", "guard/rules.py"], shipped }, ({ helperHome, hooks, read, recorded }) => {
    const before = recorded();
    let swaps = 0;
    const failSecond = (from, to) => {
      swaps += 1;
      if (swaps === 2) throw diskFull();
      renameSync(from, to);
    };
    const failed = refreshHooks(helperHome, { rename: failSecond });
    assert.deepEqual(failed, { refreshed: [], kept: [], error: "disk full" });
    for (const rel of ["guard.py", "guard/rules.py"]) assert.equal(read(rel), "old\n", rel);
    assert.deepEqual(recorded(), before);
    const left = [...readdirSync(hooks), ...readdirSync(join(hooks, "guard"))];
    assert.deepEqual(left.filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");

    // A file that already holds the helper's text, as a restore that failed leaves it, still counts
    // as installed, so the next refresh moves the rest instead of reading the hook as edited.
    put(hooks, "guard.py", "new\n");
    assert.deepEqual(refreshHooks(helperHome), { refreshed: ["guard.py"], kept: [] });
    assert.equal(read("guard/rules.py"), "new\n");
    assert.equal(recorded()["guard.py"], sha("new\n"));
  });
});

test("the hook refresh runs under the install lock after a move; when it fails, the next start finishes it", () =>
  scene({}, async ({ root, plugin, helperHome, run }) => {
    const hooks = join(root, ".claude", "hooks");
    for (const rel of ["guard.py", "edited.py"]) {
      put(hooks, rel, "old\n");
      put(hookSourcesIn(helperHome), rel, "new\n");
    }
    put(hooks, "edited.py", "mine\n");
    const files = { "guard.py": sha("old\n"), "edited.py": sha("old\n") };
    put(join(root, ".bindwright"), "hooks.json", JSON.stringify({ schema: 1, files }));
    const failing = () => {
      throw diskFull();
    };
    const first = await run({ rename: failing });
    assert.deepEqual(first, { moved: "7.2.0", hooks: { refreshed: [], kept: ["edited.py"] }, hooksError: "disk full" },
      "the move stands, the edited hook is named, and the refresh waits");
    assert.equal(readFileSync(join(hooks, "guard.py"), "utf8"), "old\n");

    // A newer pin that cannot be installed keeps the refresh pending; it runs on the helper already there.
    const next = "https://github.com/starfoxcom/bindwright/releases/download/v7.3.0/bindwright-7.3.0.tgz";
    const pin = { version: "7.3.0", node: { file: "bindwright-7.3.0.tgz", url: next, sha256: SHA } };
    writeFileSync(join(plugin, "helper.json"), JSON.stringify(pin));
    const offline = async () => {
      throw new Error("offline");
    };
    const day = { fetchFile: offline, today: "2026-11-18" };
    assert.deepEqual(await run(day), { error: "offline" });
    assert.deepEqual(await run(day), { hooks: { refreshed: ["guard.py"], kept: ["edited.py"] } });
    assert.equal(readFileSync(join(hooks, "guard.py"), "utf8"), "new\n");
    assert.deepEqual(await run(day), { skipped: "it failed today already" }, "the failed pin still waits a day");
  }));

test("the refresh is marked pending before its first swap, so a session cut off partway is finished next start", () =>
  scene({}, async ({ root, helperHome, run }) => {
    put(join(root, ".claude", "hooks"), "guard.py", "old\n");
    put(hookSourcesIn(helperHome), "guard.py", "new\n");
    put(join(root, ".bindwright"), "hooks.json", JSON.stringify({ schema: 1, files: { "guard.py": sha("old\n") } }));
    const marks = [];
    const watching = (from, to) => {
      marks.push(JSON.parse(readFileSync(join(helperHome, "follow.json"), "utf8")));
      renameSync(from, to);
    };
    assert.deepEqual((await run({ rename: watching })).hooks, { refreshed: ["guard.py"], kept: [] });
    assert.deepEqual(marks, [{ hooksPending: true }]);
    assert.ok(!existsSync(join(helperHome, "follow.json")), "a finished refresh clears the mark");
  }));

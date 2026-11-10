// The plugin's session-start notice (helper/hooks/notice.mjs): what it says,
// that it says it at most once a day per repo, asks the network at most once
// a day, and stays quiet offline. The last case runs the script from a fresh
// helper pack, as /session-start does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { notice, older, findRepo } from "../../helper/hooks/notice.mjs";
import { python } from "./python.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A temp folder with a set-up repo at its `repo/` (files from `version`), a
// cache path, and `ask`, the notice for plugin 1.4.0 on a given day.
function scene(version) {
  const root = mkdtempSync(join(tmpdir(), "bw-notice-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".bindwright"));
  writeFileSync(join(repo, ".bindwright", "pristine.json"), JSON.stringify({ version, year: 2026, files: {} }));
  const cacheFile = join(root, "config", "bindwright", "notice.json");
  const ask = (today, fetchLatest, cwd = repo) =>
    notice({ cwd, today, cacheFile, pluginVersion: "1.4.0", fetchLatest });
  return { root, repo, cacheFile, ask };
}

// A fetch stand-in that counts its calls.
function latest(version) {
  const f = async () => {
    f.calls += 1;
    if (version instanceof Error) throw version;
    return version;
  };
  f.calls = 0;
  return f;
}

test("versions compare by number, and unreadable ones never count as older", () => {
  assert.equal(older("1.4.0", "1.10.0"), true);
  assert.equal(older("v1.4.0", "1.4.1"), true);
  assert.equal(older("1.4.0", "1.4.0"), false);
  assert.equal(older("2.0.0", "1.9.9"), false);
  for (const bad of [null, undefined, "", "1.4", "next"]) {
    assert.equal(older(bad, "1.0.0"), false);
    assert.equal(older("1.0.0", bad), false);
  }
});

test("the repo is found from a subfolder, and the search stops at a git root", () => {
  const s = scene("1.0.0");
  try {
    mkdirSync(join(s.repo, "src", "deep"), { recursive: true });
    assert.equal(findRepo(join(s.repo, "src", "deep")), s.repo);
    const plain = join(s.repo, "vendor", "lib");
    mkdirSync(join(plain, ".git"), { recursive: true });
    assert.equal(findRepo(plain), null);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a repo behind the plugin hears about /bindwright:update once a day", async () => {
  const s = scene("1.3.0");
  try {
    const same = latest("1.4.0");
    assert.match(await s.ask("2026-10-31", same), /from 1\.3\.0 and the plugin is 1\.4\.0: \/bindwright:update/);
    assert.equal(await s.ask("2026-10-31", same), null);
    assert.match(await s.ask("2026-11-01", same), /\/bindwright:update/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a newer plugin is announced outside any repo too", async () => {
  const s = scene("1.4.0");
  try {
    const text = await s.ask("2026-10-31", latest("1.5.0"), s.root);
    assert.equal(text, "Bindwright 1.5.0 is out; this machine has 1.4.0. Update the plugin with /plugin.");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("the network is asked at most once a day, and nothing up to date says anything", async () => {
  const s = scene("1.4.0");
  try {
    const fetchLatest = latest("1.4.0");
    assert.equal(await s.ask("2026-10-31", fetchLatest), null);
    assert.equal(await s.ask("2026-10-31", fetchLatest), null);
    assert.equal(fetchLatest.calls, 1);
    await s.ask("2026-11-01", fetchLatest);
    assert.equal(fetchLatest.calls, 2);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("offline is quiet, and keeps what the last check found", async () => {
  const s = scene("1.4.0");
  try {
    const offline = latest(new Error("ENOTFOUND"));
    assert.equal(await s.ask("2026-10-31", offline), null);
    assert.equal(offline.calls, 1);
    // Online yesterday found 1.5.0: an offline day still knows it.
    writeFileSync(s.cacheFile, JSON.stringify({ checked: "2026-11-01", latest: "1.5.0", shown: {} }));
    assert.match(await s.ask("2026-11-02", offline), /1\.5\.0 is out/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a damaged cache is replaced instead of breaking the notice", async () => {
  const s = scene("1.3.0");
  try {
    mkdirSync(dirname(s.cacheFile), { recursive: true });
    for (const damaged of ["not json", JSON.stringify({ shown: 5 }), "null"]) {
      writeFileSync(s.cacheFile, damaged);
      assert.match(await s.ask("2026-10-31", latest(null)), /\/bindwright:update/, damaged);
      assert.equal(JSON.parse(readFileSync(s.cacheFile, "utf8")).shown[s.repo], "2026-10-31");
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a cache folder the session cannot write still lets the notice out", async () => {
  const s = scene("1.0.0");
  try {
    // A file where the cache folder belongs makes every write fail, as a sandboxed shell does.
    writeFileSync(join(s.root, "config"), "");
    const text = await s.ask("2026-10-31", latest(null));
    assert.match(text, /from 1\.0\.0 .*\/bindwright:update/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("only the plain x.y.z form of a version reaches the text", async () => {
  const s = scene(`vvv0.1.0${"\n".repeat(50)}`);
  try {
    const text = await s.ask("2026-10-31", latest(null));
    assert.match(text, /come from 0\.1\.0 and the plugin/);
    assert.ok(!text.includes("v0.1.0") && !text.includes("\n\n"));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a session starting meanwhile keeps the mark it saved", async () => {
  const s = scene("1.3.0");
  try {
    // Another session marks its repo while this one waits on the network.
    const slow = async () => {
      mkdirSync(dirname(s.cacheFile), { recursive: true });
      const theirs = { checked: "2026-10-31", latest: "1.4.0", shown: { other: "2026-10-31" } };
      writeFileSync(s.cacheFile, JSON.stringify(theirs));
      return "1.4.0";
    };
    assert.match(await s.ask("2026-10-31", slow), /\/bindwright:update/);
    const shown = JSON.parse(readFileSync(s.cacheFile, "utf8")).shown;
    assert.deepEqual(shown, { [s.repo]: "2026-10-31", other: "2026-10-31" });
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("drift names the extras the repo's setup expects, and nothing else", async () => {
  const s = scene("1.4.0");
  try {
    const ask = (driftFor, cwd = s.repo) =>
      notice({ cwd, today: "2026-10-31", cacheFile: s.cacheFile, pluginVersion: "1.4.0", fetchLatest: latest(null),
        driftFor });
    const text = await ask(async () => ["tasks", "x; rm -rf ~", "ci-watch"]);
    assert.equal(text, "This repo's Bindwright setup expects extras this machine lacks (tasks, ci-watch): "
      + "/bindwright:join walks through them, and remembers a no.");
    rmSync(s.cacheFile);
    assert.equal(await ask(async () => { throw new Error("no engine"); }), null);
    assert.equal(await ask(async () => ["tasks"], s.root), null, "outside a set-up repo");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a failed review counts send is named in a repo, and nowhere else", async () => {
  const s = scene("1.4.0");
  try {
    const ask = (countsFailedAt, cwd = s.repo) =>
      notice({ cwd, today: "2026-11-10", cacheFile: s.cacheFile, pluginVersion: "1.4.0", fetchLatest: latest(null),
        countsFailedAt });
    const failedAt = new Date(2026, 10, 9, 12).getTime();
    assert.match(await ask(failedAt), /this repo's last send failed \(2026-11-09\)/);
    rmSync(s.cacheFile);
    assert.equal(await ask(null), null, "no failure");
    assert.equal(await ask(failedAt, s.root), null, "outside a repo");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a helper at another version than the plugin points at /bindwright:update", async () => {
  const s = scene("1.4.0");
  try {
    const text = await notice({
      cwd: s.repo, today: "2026-11-08", cacheFile: s.cacheFile, pluginVersion: "1.4.0", helperVersion: "1.3.0",
      fetchLatest: latest(null),
    });
    assert.equal(text, "Bindwright's helper is 1.3.0 and the plugin is 1.4.0: "
      + "/bindwright:update brings the helper to the plugin's version.");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

const needs = { skip: !python && "needs Python 3.8+" };

test("the notice, run from the helper as /session-start runs it, tells the user and then stays quiet", needs, () => {
  const s = scene("0.1.0");
  try {
    const helper = join(s.root, "helper");
    const pack = [join(repoRoot, "tools", "pack_plugin.py"), "--helper-out", helper];
    const packed = spawnSync(python, pack, { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    // The plugin folder holds only its manifest here, at the helper's version.
    const plugin = join(s.root, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    const version = readFileSync(join(helper, "VERSION"), "utf8").trim().replace(/^v/, "");
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "bindwright", version }));
    // The helper reached through a link too, as a linked home folder does.
    const linked = join(s.root, "linked");
    symlinkSync(helper, linked, "junction");
    // A plugin checkout whose manifest names no version keeps it in a VERSION file.
    const checkout = join(s.root, "checkout");
    mkdirSync(join(checkout, ".claude-plugin"), { recursive: true });
    writeFileSync(join(checkout, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "bindwright" }));
    writeFileSync(join(checkout, "VERSION"), `v${version}\n`);
    const cases = [["helper", helper, plugin], ["linked", linked, plugin], ["checkout", helper, checkout]];
    for (const [name, root, pluginFolder] of cases) {
      const env = {
        ...process.env, CLAUDE_CONFIG_DIR: join(s.root, `config-${name}`),
        BINDWRIGHT_LATEST_URL: "http://127.0.0.1:9/VERSION", // nothing listens there: offline
      };
      const setup = { schema: 1, extras: { tasks: "recommended" } };
      const project = { team: true, client: false, project: {}, advanced: { tracker: "github" }, setup };
      writeFileSync(join(s.repo, ".bindwright", "project.json"), JSON.stringify(project));
      const script = join(root, "hooks", "notice.mjs");
      const options = { cwd: s.repo, env, encoding: "utf8" };
      const run = () => spawnSync(process.execPath, [script, "--plugin", pluginFolder], options);
      const first = run();
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /from 0\.1\.0 .*\/bindwright:update/, name);
      assert.match(first.stdout, /expects extras this machine lacks \(tasks\)/);
      assert.doesNotMatch(first.stdout, /helper/, "a helper at the plugin's version says nothing");
      const second = run();
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout, "");
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

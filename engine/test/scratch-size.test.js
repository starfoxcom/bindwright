// The scratch-folder size check (helper/hooks/scratch-size.mjs): what it counts, where the limit
// falls, that a walk past its budget says its sizes are lower bounds, how a saved measurement is
// read and aged, and that the start-session notice carries its line without letting a failure
// cost the rest.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEASURE_EVERY_MS, isDue, savedUsage, scratchLine, scratchRoots, scratchUsage,
} from "../../helper/hooks/scratch-size.mjs";
import { notice } from "../../helper/hooks/notice.mjs";

// Every temp folder a test made, removed once the file's tests end.
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// A temp folder holding the given files, each path relative to it.
function folder(layout) {
  const root = mkdtempSync(join(tmpdir(), "bw-scratch-"));
  made.push(root);
  for (const [path, bytes] of Object.entries(layout)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, Buffer.alloc(bytes));
  }
  return root;
}

const relative = (base, usage) =>
  usage.sessions.map((s) => [s.folder.slice(base.length + 1).replace(/\\/g, "/"), s.bytes]);

test("each session folder is sized with everything under it, biggest first", () => {
  const root = folder({
    "p1/s1/scratchpad/a.bin": 10, "p1/s1/scratchpad/deep/b.bin": 5, "p1/s2/c.bin": 30, "p2/s3/d.bin": 1,
  });
  const usage = scratchUsage({ roots: [root] });
  assert.equal(usage.total, 46);
  assert.equal(usage.isPartial, false);
  assert.deepEqual(relative(root, usage), [["p1/s2", 30], ["p1/s1", 15], ["p2/s3", 1]]);
});

test("this user's Claude Code folder is found under both of its names, and nobody else's", () => {
  const base = folder({
    "claude/p/s/a.bin": 3, "claude-1000/p/s/b.bin": 4, "claude-1001/p/s/e.bin": 50, "claude-x/p/s/c.bin": 50,
    "other/p/s/d.bin": 50,
  });
  const env = { CLAUDE_CODE_TMPDIR: base };
  const usage = scratchUsage({ roots: scratchRoots(env, 1000) });
  assert.deepEqual(relative(base, usage), [["claude-1000/p/s", 4], ["claude/p/s", 3]]);
  // A system with no user ids (Windows) has only the one name.
  assert.deepEqual(relative(base, scratchUsage({ roots: scratchRoots(env, undefined) })), [["claude/p/s", 3]]);
});

test("the line comes at the limit and not one byte under it", () => {
  const roots = [folder({ "p/s/a.bin": 100 })];
  const rows = [["one byte under", 101, false], ["at the limit", 100, true], ["past it", 99, true]];
  for (const [name, limit, isOver] of rows) {
    const usage = scratchUsage({ roots, limit });
    assert.equal(usage.isOver, isOver, name);
    assert.equal(scratchLine(usage) !== null, isOver, name);
  }
  assert.match(scratchLine(scratchUsage({ roots, limit: 1 })), /hold 0\.0 GB: .*Nothing was deleted\.$/);
});

test("a missing folder counts nothing, and a walk past its budget stops inside a folder", () => {
  assert.deepEqual(scratchUsage({ roots: [join(tmpdir(), "bw-scratch-none")] }).sessions, []);
  const roots = [folder({ "p/s/a.bin": 10, "p/s/b.bin": 10, "p/s/c.bin": 10 })];
  let clock = 0;
  const usage = scratchUsage({ roots, limit: 1, budgetMs: 2, now: () => (clock += 1) });
  assert.equal(usage.isPartial, true);
  assert.ok(usage.total < 30, "it stopped before the folder's last file");
  assert.match(scratchLine(usage), /hold over /);
});

test("a saved measurement is read back, and a day later it is due again", () => {
  const dir = folder({});
  const file = join(dir, "scratch-size.json");
  assert.equal(savedUsage(file), null);
  assert.equal(isDue(file), true, "no measurement yet");
  writeFileSync(file, JSON.stringify(scratchUsage({ roots: [folder({ "p/s/a.bin": 2 })], limit: 1 })));
  assert.match(scratchLine(savedUsage(file)), /scratch folders hold/);
  assert.equal(isDue(file), false, "just measured");
  const dayAgo = (Date.now() - MEASURE_EVERY_MS) / 1000;
  utimesSync(file, dayAgo, dayAgo);
  assert.equal(isDue(file), true, "a day old");
  writeFileSync(file, "{not json");
  assert.equal(scratchLine(savedUsage(file)), null);
});

test("the start-session notice carries the line, and a failing check costs nothing else", async () => {
  const cwd = folder({});
  let n = 0;
  const ask = (scratchFor) => notice({
    cwd, today: "2026-11-24", cacheFile: join(cwd, "cache", `${(n += 1)}.json`), pluginVersion: "1.4.0",
    fetchLatest: async () => "1.5.0", scratchFor,
  });
  assert.match(await ask(() => "scratch line"), /1\.5\.0 is out[\s\S]*\nscratch line$/);
  const text = await ask(() => {
    throw new Error("unreadable");
  });
  assert.match(text, /1\.5\.0 is out/);
  assert.doesNotMatch(text, /scratch/);
});

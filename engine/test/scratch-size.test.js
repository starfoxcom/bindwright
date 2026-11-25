// The scratch-folder size check (helper/hooks/scratch-size.mjs): what it counts, where the limit
// falls, that a walk past its budget says its sizes are lower bounds, and that the start-session
// notice carries its line without letting a failure cost the rest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchLine, scratchRoot, scratchUsage } from "../../helper/hooks/scratch-size.mjs";
import { notice } from "../../helper/hooks/notice.mjs";

// A temp root holding `<project>/<session>/` folders with files of the given sizes.
function scratch(layout) {
  const root = mkdtempSync(join(tmpdir(), "bw-scratch-"));
  for (const [path, bytes] of Object.entries(layout)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, Buffer.alloc(bytes));
  }
  return root;
}

test("each session folder is sized with everything under it, biggest first", () => {
  const root = scratch({
    "p1/s1/scratchpad/a.bin": 10, "p1/s1/scratchpad/deep/b.bin": 5, "p1/s2/c.bin": 30, "p2/s3/d.bin": 1,
  });
  const usage = scratchUsage({ root });
  assert.equal(usage.total, 46);
  assert.equal(usage.isPartial, false);
  assert.deepEqual(usage.sessions.map((s) => [s.folder.slice(root.length + 1).replace(/\\/g, "/"), s.bytes]),
    [["p1/s2", 30], ["p1/s1", 15], ["p2/s3", 1]]);
});

test("the line comes at the limit and not one byte under it", () => {
  const root = scratch({ "p/s/a.bin": 100 });
  const rows = [["one byte under", 101, false], ["at the limit", 100, true], ["past it", 99, true]];
  for (const [name, limit, isOver] of rows) {
    const usage = scratchUsage({ root, limit });
    assert.equal(usage.isOver, isOver, name);
    assert.equal(scratchLine(usage) !== null, isOver, name);
  }
  assert.match(scratchLine(scratchUsage({ root, limit: 1 })), /hold 0\.0 GB .*Nothing was deleted\.$/);
});

test("a missing folder counts nothing, and a walk past its budget says so", () => {
  assert.deepEqual(scratchUsage({ root: join(tmpdir(), "bw-scratch-none") }).sessions, []);
  const root = scratch({ "p/s1/a.bin": 10, "p/s2/b.bin": 10 });
  let clock = 0;
  const usage = scratchUsage({ root, limit: 1, budgetMs: 1, now: () => (clock += 1) });
  assert.equal(usage.isPartial, true);
  assert.match(scratchLine(usage), /hold over /);
});

test("the folder follows Claude Code's own temp setting", () => {
  assert.equal(scratchRoot({ CLAUDE_CODE_TMPDIR: join("x", "t") }), join("x", "t", "claude"));
  assert.equal(scratchRoot({}), join(tmpdir(), "claude"));
});

test("the start-session notice carries the line, and a failing check costs nothing else", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bw-scratch-cwd-"));
  const ask = (scratchFor) => notice({
    cwd, today: "2026-11-24", cacheFile: join(cwd, "cache", `${Math.random()}.json`), pluginVersion: "1.4.0",
    fetchLatest: async () => "1.5.0", scratchFor,
  });
  assert.match(await ask(() => "scratch line"), /1\.5\.0 is out[\s\S]*\nscratch line$/);
  const text = await ask(() => {
    throw new Error("unreadable");
  });
  assert.match(text, /1\.5\.0 is out/);
  assert.doesNotMatch(text, /scratch/);
});

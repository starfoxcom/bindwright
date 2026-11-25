// /bindwright:update's key-by-key merge of JSON settings for a repo that moved a key: plain
// JSON merges, and anything the two engines could read differently stays a conflict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gitMerge } from "../update.js";
import { SETTINGS, needsPython, update } from "./update-run.js";

// The settings with the first hook's timeout at a value the templates no longer have.
const olderTimeout = (text) => text.replace(/"timeout": \d+/, '"timeout": 5');
const firstTimeout = (text) => JSON.parse(text).hooks.PreToolUse[0].hooks[0].timeout;

// The same settings with the hooks key moved to the end, and nothing else changed.
function reordered(text) {
  const { hooks, ...rest } = JSON.parse(text);
  return `${JSON.stringify({ ...rest, hooks }, null, 2)}\n`;
}

test("a repo that moved its hooks key merges key by key", needsPython, async () => {
  let base, ours, theirs;
  const { out, repo } = await update((r) => {
    theirs = r.read(SETTINGS);
    base = olderTimeout(theirs);
    ours = reordered(base);
    r.pristine.files[SETTINGS] = base;
    r.write(SETTINGS, ours);
  });
  assert.ok(gitMerge(ours, base, theirs).conflicts > 0, "git's line merge clashes on these texts");
  assert.deepEqual(out.merged, [SETTINGS]);
  const merged = repo.read(SETTINGS);
  assert.deepEqual(Object.keys(JSON.parse(merged)), Object.keys(JSON.parse(ours)));
  assert.equal(firstTimeout(merged), firstTimeout(theirs));
  assert.equal(merged.match(/^ {2}"hooks": /gm).length, 1);
});

// Each row turns the moved-hooks copy into one the key merge must leave a conflict.
const atTop = (line) => (text) => text.replace("{\n", `{\n  ${line},\n`);
const STAYS_CONFLICT = {
  "a key both sides changed differently": (text) => text.replace(/"timeout": \d+/, '"timeout": 99'),
  "a repo copy that is not valid JSON": (text) => text.replace(/\n\}\n$/, ",\n}\n"),
  "a key repeated in its object": atTop('"//": "one",\n  "//": "two"'),
  "an object nested past the depth both twins read": atTop(`"deep": ${"[".repeat(65)}${"]".repeat(65)}`),
  "an integer past 2^53": atTop('"big": 9007199254740993'),
  "an all-digit key JavaScript moves first": atTop('"10": true'),
  "an escape of half a surrogate pair": atTop('"s": "\\ud800"'),
  "an indent longer than 10 characters": (text) => text.replace(/^ +/gm, (spaces) => spaces.repeat(6)),
  "a kept section the templates change": (text) => text
    .replace('  "hooks": ', '  "//keep": "bindwright:keep",\n  "hooks": ')
    .replace(/\n\}\n$/, ',\n  "//end": "bindwright:end-keep"\n}\n'),
};

// Text both twins read and reprint alike; update() compares the two engines' bytes.
const MERGES_ALIKE = {
  "a number written with a fraction": atTop('"ratio": 1.0'),
  "a carriage return between tokens": (text) => text.replace("{\n", "{\r \n"),
};

test("the key merge takes plain JSON and leaves the rest a conflict", needsPython, async () => {
  const rows = [
    ...Object.entries(STAYS_CONFLICT).map(([name, change]) => [name, change, "conflict"]),
    ...Object.entries(MERGES_ALIKE).map(([name, change]) => [name, change, "merged"]),
  ];
  for (const [name, change, outcome] of rows) {
    const { out } = await update((r) => {
      const base = olderTimeout(r.read(SETTINGS));
      r.pristine.files[SETTINGS] = base;
      r.write(SETTINGS, change(reordered(base)));
    });
    assert.deepEqual(out[outcome], [SETTINGS], name);
  }
});

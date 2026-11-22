// Every shipped text that tells how many lookups a red-round step back takes says five, the count the
// ci-watch mod enforces (`SOURCES_NEEDED`), and none still says three.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THREE_LOOKUPS = new RegExp(String.raw`\bthree (?:distinct |different )?(?:web )?`
  + String.raw`(?:lookups|ways (?:others|the community))|looked up three ways`, "i");

function shippedFiles() {
  const listed = spawnSync("git", ["ls-files", "_core", "plugin"], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\n").filter(path => /\.(md|ts|tsx|js|mjs|py|template)$/.test(path)
    && !/\/tests?\//.test(path));
}

test("no shipped text says a step back takes three lookups", () => {
  const stale = [];
  for (const path of shippedFiles()) {
    for (const line of readFileSync(join(root, path), "utf8").split(/\r?\n/)) {
      if (THREE_LOOKUPS.test(line)) stale.push(`${path}: ${line.trim()}`);
    }
  }
  assert.deepEqual(stale, []);
});

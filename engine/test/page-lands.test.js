// The "what lands where" scene names real paths: each one is a file that setup writes,
// or a folder that holds files, so the page never promises a file setup does not make.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computer, project } from "../../page/lands-data.js";
import { DICTIONARIES } from "../../page/i18n/index.js";
import { bind } from "../bind.js";
import { defaults } from "../model.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(engine, "..");
const coreFiles = JSON.parse(readFileSync(join(engine, "core-files.json"), "utf8"));
const readFile = async (path) => readFileSync(join(repo, path), "utf8");
const STAGING = ".bindwright/incoming/";
// The ~/.claude paths setup writes under .bindwright/global/, keyed by their own name.
const GLOBAL_SOURCE = { "~/.claude/CLAUDE.md": ".bindwright/global/CLAUDE.md.additions" };
const globalSource = (path) =>
  GLOBAL_SOURCE[path] ?? path.replace("~/.claude/", ".bindwright/global/");
// The plugin is installed by Claude Code itself, not written by setup.
const INSTALLED_BY_PLUGIN = ["~/.claude/plugins/"];

const options = { readFile, coreFiles, year: 2026, version: "2.0.0" };
const bound = await bind(structuredClone(defaults()), options);
const written = [...bound.keys()]
  .map((dest) => (dest.startsWith(STAGING) ? dest.slice(STAGING.length) : dest));

// A folder path matches any written file under it; a file path must match exactly.
const isWritten = (path) =>
  written.some((file) => (path.endsWith("/") ? file.startsWith(path) : file === path));

for (const { key, path } of project) {
  test(`project row "${key}" shows ${path}, a path setup writes`, () => {
    assert.ok(isWritten(path), path);
  });
}

for (const { key, path } of computer) {
  if (INSTALLED_BY_PLUGIN.includes(path)) continue;
  test(`computer row "${key}" shows ${path}, a path setup writes`, () => {
    if (path.endsWith("/")) {
      const folder = join(repo, "_core", "global-template", path.replace("~/.claude/", ""));
      assert.ok(readdirSync(folder).length > 0, folder);
    } else {
      assert.ok(written.includes(globalSource(path)), globalSource(path));
    }
  });
}

test("every row's label exists in each language", () => {
  for (const [code, words] of Object.entries(DICTIONARIES)) {
    for (const { key } of [...computer, ...project]) {
      assert.equal(typeof words[`lands.item.${key}`], "string", `${code}: lands.item.${key}`);
    }
  }
});

test("every row has its own key, so each label is unique", () => {
  const keys = [...computer, ...project].map(({ key }) => key);
  assert.equal(new Set(keys).size, keys.length);
});

// The settings page lists every answer the engine keeps, so a setting cannot go
// missing, name a key the engine lacks, or drift from the defaults it describes.
// tools/page_settings.mjs fills the page from page/settings-data.js; the Spanish
// copy is checked in page-languages.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPUTER, FIXED, MODS_ROWS, PROJECT } from "../../page/settings-data.js";
import { DICTIONARIES } from "../../page/i18n/index.js";
import { alternates, pageKeys, switchLinks } from "../../page/i18n/render.js";
import { fillSettings } from "../../tools/page_settings.mjs";
import { EXTRAS, MODS } from "../layers.js";
import { CODE_RESEARCH_TOOLS, defaults } from "../model.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "page");
const read = (path) => readFileSync(join(page, path), "utf8").replace(/\r\n/g, "\n");
const settings = read("settings/index.html");
const entries = [...COMPUTER, ...PROJECT, ...FIXED];
const answerKeys = entries.flatMap((entry) => entry.keys).filter((key) => !key.startsWith("extra:") && key !== "mods");

// Every answer key the engine's defaults hold, dotted as the answers are: "project.name".
function flatten(obj, prefix = "") {
  return Object.entries(obj).flatMap(([key, value]) => {
    const name = `${prefix}${key}`;
    return value !== null && typeof value === "object" ? flatten(value, `${name}.`) : [name];
  });
}

test("the settings page on disk is the one the generator writes", () => {
  assert.equal(settings, fillSettings(settings));
});

test("the settings page links every language and marks itself as the current page", () => {
  assert.ok(settings.includes(`<!-- alternates -->\n${alternates("settings/")}\n<!-- /alternates -->`));
  assert.ok(settings.includes(switchLinks("en", "settings/")));
  assert.ok(settings.includes('aria-current="page"'));
});

test("the settings page runs no script", () => {
  assert.ok(!settings.includes("<script"));
});

test("every answer the engine keeps is listed by exactly one entry", () => {
  assert.deepEqual([...answerKeys].sort(), flatten(defaults()).sort());
});

test("the extra settings and the mods entry cover every extra and the mods", () => {
  const extras = entries.flatMap((entry) => entry.keys)
    .filter((key) => key.startsWith("extra:"))
    .map((key) => key.slice("extra:".length));
  assert.deepEqual(extras.sort(), EXTRAS.filter((name) => !MODS.includes(name)).sort());
  assert.equal(entries.filter((entry) => entry.keys.includes("mods")).length, 1);
});

test("the mods rows are the engine's mods, in the engine's order", () => {
  assert.deepEqual(MODS_ROWS.map((row) => row.id), MODS);
});

test("every engine check holds against the defaults for its answers", () => {
  for (const entry of entries) {
    for (const check of entry.engine ?? []) {
      const value = check.key.split(".").reduce((obj, part) => obj[part], defaults(check.flags));
      assert.deepEqual(value, check.value, `${entry.id}: ${check.key}`);
    }
  }
});

test("the code-search options are the code-search tools, each named in the text", () => {
  const search = COMPUTER.find((entry) => entry.id === "code-research");
  const tools = Object.keys(CODE_RESEARCH_TOOLS).filter((tool) => tool !== "custom");
  assert.deepEqual([...search.options].sort(), tools.sort());
  for (const option of search.options) assert.ok(search.text.includes(option), option);
});

test("every row id is unique", () => {
  const ids = [...entries, ...MODS_ROWS].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the settings page's element ids are unique", () => {
  const ids = [...settings.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("every translation key on the settings page has Spanish text", () => {
  for (const key of pageKeys(settings)) {
    assert.equal(typeof DICTIONARIES.es[key], "string", key);
  }
});

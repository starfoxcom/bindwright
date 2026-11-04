// The landing page's mods section shows one card per mod the engine can add. The cards
// come from the same data as the All settings page, so they cannot drift from it.
// tools/page_settings.mjs fills the cards; the Spanish copy is checked in page-languages.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTIONARIES } from "../../page/i18n/index.js";
import { pageKeys } from "../../page/i18n/render.js";
import { fillMods } from "../../tools/page_settings.mjs";
import { SCENES } from "../../page/mods-scenes.js";
import { MODS } from "../layers.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "page");
const read = (path) => readFileSync(join(page, path), "utf8").replace(/\r\n/g, "\n");
const landing = read("index.html");
const spanish = read("es/index.html");

// The mods section's markup, from its opening tag to its closing tag.
function modsSection(html) {
  const start = html.indexOf('<section class="mods"');
  return html.slice(start, html.indexOf("</section>", start));
}

const cardIds = (html) =>
  [...modsSection(html).matchAll(/<li class="mod-card" id="([^"]+)"/g)].map((m) => m[1]);

test("the landing page on disk is the one the generator writes", () => {
  assert.equal(landing, fillMods(landing));
});

test("the landing's mod cards are the engine's mods, in the engine's order", () => {
  assert.deepEqual(cardIds(landing), MODS.map((id) => `m-${id}`));
});

test("the Spanish landing has the same mod cards", () => {
  assert.ok(spanish.includes('<section class="mods"'));
  assert.deepEqual(cardIds(spanish), cardIds(landing));
});

test("the mods section links to the mods row on the settings page", () => {
  assert.ok(modsSection(landing).includes('href="settings/#mods"'));
  assert.ok(read("settings/index.html").includes('id="mods"'));
});

test("every translation key in the mods section has Spanish text", () => {
  for (const key of pageKeys(modsSection(landing))) {
    assert.equal(typeof DICTIONARIES.es[key], "string", key);
  }
});

test("the mods section shows a carousel and a terminal, with the mod before the terminal", () => {
  const section = modsSection(landing);
  assert.ok(section.includes('id="mods-stage"'));
  assert.ok(section.includes('class="term"'));
  assert.ok(section.indexOf('id="mods-carousel"') < section.indexOf('class="term"'));
});

test("every mod in the engine has a scene, and no scene is for a mod the engine lacks", () => {
  assert.deepEqual(Object.keys(SCENES).sort(), [...MODS].sort());
});

test("every text a mod scene shows exists in each language", () => {
  const source = read("mods-scenes.js");
  const keys = [...source.matchAll(/"(mods\.scene\.[^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  for (const [code, words] of Object.entries(DICTIONARIES)) {
    for (const key of keys) assert.equal(typeof words[key], "string", `${code}: ${key}`);
  }
});

test("the landing page's element ids are unique", () => {
  const ids = [...landing.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

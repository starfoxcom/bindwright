// Every language's page is generated from page/index.html, so a stale page,
// a missing translation or a dropped {placeholder} would ship text a visitor
// cannot read. tools/page_languages.mjs rewrites the pages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTIONARIES, t } from "../../page/i18n/index.js";
import { LANGUAGES } from "../../page/i18n/languages.js";
import { alternates, pageKeys, renderLanguage, switchLinks } from "../../page/i18n/render.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "page");
const read = (path) => readFileSync(join(page, path), "utf8").replace(/\r\n/g, "\n");
const english = read("index.html");
const translated = LANGUAGES.filter((l) => l.folder);
const placeholders = (text) => [...JSON.stringify(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("the English page links every language for search engines and visitors", () => {
  assert.ok(english.includes(`<!-- alternates -->\n${alternates()}\n<!-- /alternates -->`));
  assert.ok(english.includes(switchLinks("en")));
});

for (const { code, folder } of translated) {
  const words = DICTIONARIES[code];

  test(`${code}: the page on disk is the one the generator writes`, () => {
    assert.equal(read(`${folder}index.html`), renderLanguage(english, code, words));
  });

  test(`${code}: the page keeps every element the scripts look up`, () => {
    const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids(read(`${folder}index.html`)), ids(english));
  });

  test(`${code}: the dictionary has exactly the page's and the scripts' keys`, () => {
    const wanted = new Set([...pageKeys(english), ...Object.keys(DICTIONARIES.en)]);
    assert.deepEqual([...wanted].filter((key) => !(key in words)), [], "missing");
    assert.deepEqual(Object.keys(words).filter((key) => !wanted.has(key)), [], "unused");
  });

  test(`${code}: every script text keeps the English placeholders and plural forms`, () => {
    for (const [key, text] of Object.entries(DICTIONARIES.en)) {
      assert.deepEqual([...new Set(placeholders(words[key]))], [...new Set(placeholders(text))], key);
      assert.equal(typeof words[key], typeof text, key);
      if (typeof text === "object") assert.equal(typeof words[key].other, "string", key);
    }
  });
}

test("a script text fills its values, and a missing key is an error", () => {
  const plural = Object.entries(DICTIONARIES.en).find(([, text]) => typeof text === "object");
  if (plural) {
    const [key, { one, other }] = plural;
    assert.equal(t(key, { count: 1 }), one.replace(/\{count\}/g, "1"));
    assert.equal(t(key, { count: 2 }), other.replace(/\{count\}/g, "2"));
  }
  assert.throws(() => t("no.such.key"), /no page text/);
});

test("every t() key literal in the page scripts exists in the English dictionary", () => {
  const scripts = readdirSync(page).filter((file) => file.endsWith(".js"));
  const keys = scripts.flatMap((file) => [...read(file).matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]));
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => !(key in DICTIONARIES.en)), []);
});

// Every language's page is generated from its English page, so a stale page,
// a missing translation or a dropped {placeholder} would ship text a visitor
// cannot read. tools/page_languages.mjs rewrites the pages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTIONARIES, t } from "../../page/i18n/index.js";
import { LANGUAGES, PAGES } from "../../page/i18n/languages.js";
import { alternates, pageKeys, renderLanguage, sitemap, switchLinks } from "../../page/i18n/render.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "page");
const read = (path) => readFileSync(join(page, path), "utf8").replace(/\r\n/g, "\n");
const english = Object.fromEntries(PAGES.map(({ file }) => [file, read(file)]));
const translated = LANGUAGES.filter((l) => l.folder);
const placeholders = (text) => [...JSON.stringify(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("each English page links every language for search engines and visitors", () => {
  for (const { file, path } of PAGES) {
    assert.ok(english[file].includes(`<!-- alternates -->\n${alternates(path)}\n<!-- /alternates -->`), file);
    assert.ok(english[file].includes(switchLinks("en", path)), file);
  }
});

test("the sitemap on disk is the one the generator writes", () => {
  assert.equal(readFileSync(join(page, "..", "sitemap.xml"), "utf8").replace(/\r\n/g, "\n"), sitemap());
});

for (const { code, folder } of translated) {
  const words = DICTIONARIES[code];

  for (const { file, path } of PAGES) {
    test(`${code}: the ${file} page on disk is the one the generator writes`, () => {
      assert.equal(read(`${folder}${file}`), renderLanguage(english[file], code, words, path));
    });

    test(`${code}: the ${file} page keeps every element the scripts look up`, () => {
      const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(ids(read(`${folder}${file}`)), ids(english[file]));
    });
  }

  test(`${code}: the dictionary has exactly the pages' and the scripts' keys`, () => {
    const pageText = PAGES.flatMap(({ file }) => pageKeys(english[file]));
    const wanted = new Set([...pageText, ...Object.keys(DICTIONARIES.en)]);
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
  const keyCalls = (file) => [...read(file).matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]);
  const keys = scripts.flatMap(keyCalls);
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => !(key in DICTIONARIES.en)), []);
});

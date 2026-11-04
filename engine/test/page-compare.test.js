// The compare page sets a work day without Bindwright beside the same day with it,
// one row per moment. Its rows, their text keys and the header links to it are checked
// here; tools/page_languages.mjs writes the Spanish page, which page-languages.test.js checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTIONARIES } from "../../page/i18n/index.js";
import { PAGES } from "../../page/i18n/languages.js";
import { pageKeys } from "../../page/i18n/render.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "page");
const read = (path) => readFileSync(join(page, path), "utf8").replace(/\r\n/g, "\n");
const compare = read("compare/index.html");
const spanish = read("es/compare/index.html");

// English lives in the page itself; every other language has its own dictionary.
const translated = Object.entries(DICTIONARIES).filter(([code]) => code !== "en");

const ROWS = ["start", "code", "risky", "pr", "ci", "compact", "limit", "commit", "end"];

// The moments list's markup, from its opening tag to its closing tag.
function momentsList(html) {
  const start = html.indexOf('<ul class="moments"');
  return html.slice(start, html.indexOf("</ul>", start));
}

// One row's markup, from its opening tag to its closing tag.
function rowMarkup(html, id) {
  const start = html.indexOf(`<li class="moment" id="${id}"`);
  return html.slice(start, html.indexOf("</li>", start));
}

// The site header's navigation, from its opening tag to its closing tag.
function siteNav(html) {
  const start = html.indexOf('<nav aria-label="Site"');
  return html.slice(start, html.indexOf("</nav>", start));
}

const rowIds = (html) => [...momentsList(html).matchAll(/<li class="moment" id="([^"]+)"/g)].map((m) => m[1]);

test("the compare page has the nine moments in order, in English and Spanish", () => {
  const expected = ROWS.map((id) => `c-${id}`);
  assert.deepEqual(rowIds(compare), expected);
  assert.deepEqual(rowIds(spanish), expected);
});

test("every row has a moment, a without and a with text, each translated", () => {
  for (const id of ROWS) {
    const row = rowMarkup(compare, `c-${id}`);
    const keys = pageKeys(row);
    assert.match(row, new RegExp(`<h3 data-t="compare\\.${id}\\.moment">`), id);
    assert.match(row, new RegExp(`<p class="without">[\\s\\S]*?data-t="compare\\.${id}\\.without"`), id);
    assert.match(row, new RegExp(`<p class="with">[\\s\\S]*?data-t="compare\\.${id}\\.with"`), id);
    for (const part of ["moment", "without", "with"]) {
      const key = `compare.${id}.${part}`;
      assert.ok(keys.includes(key), key);
      for (const [code, words] of translated) {
        assert.equal(typeof words[key], "string", `${code}: ${key}`);
      }
    }
  }
});

test("every English page links the compare page between the settings and GitHub links", () => {
  const hrefs = { "index.html": "compare/", "settings/index.html": "../compare/", "compare/index.html": "./" };
  for (const { file } of PAGES) {
    const nav = siteNav(read(file));
    const keys = pageKeys(nav);
    const at = (key) => keys.indexOf(key);
    assert.ok(at("nav.settings") < at("nav.compare") && at("nav.compare") < at("nav.github"), file);
    const link = nav.match(/<a ([^>]*)data-t="nav\.compare"/)?.[1] ?? "";
    assert.ok(link.includes(`href="${hrefs[file]}"`), file);
    assert.equal(link.includes('aria-current="page"'), file === "compare/index.html", file);
  }
});

test("the compare page's element ids are unique", () => {
  for (const html of [compare, spanish]) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  }
});

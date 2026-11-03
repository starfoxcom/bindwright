// The evidence section's totals are the sums of its per-project rows, so the big
// numbers cannot drift from the chart. Each project's counts also keep their order:
// fixed is within reviewed. Each project's name has its label in both dictionaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { projects } from "../../page/evidence-data.js";
import { DICTIONARIES } from "../../page/i18n/index.js";
import { renderLanguage } from "../../page/i18n/render.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "page");
const html = readFileSync(join(page, "index.html"), "utf8");

// The data-count of the stat tagged data-total="<name>" in the English page.
function total(name) {
  const tag = html.match(new RegExp(`<[^>]*data-total="${name}"[^>]*>`))?.[0];
  assert.ok(tag, `no stat tagged data-total="${name}"`);
  return Number(tag.match(/data-count="(\d+)"/)[1]);
}

const sum = (field) => projects.reduce((count, project) => count + project[field], 0);

test("the reviewed total is the sum of the projects' reviewed counts", () => {
  assert.equal(total("reviewed"), sum("reviewed"));
});

test("the fixed total is the sum of the projects' fixed counts", () => {
  assert.equal(total("fixed"), sum("fixed"));
});

for (const { name, reviewed, fixed } of projects) {
  test(`project "${name}": fixed <= reviewed`, () => {
    assert.ok(fixed <= reviewed, `fixed ${fixed} > reviewed ${reviewed}`);
  });
}

for (const { name } of projects) {
  for (const [code, words] of Object.entries(DICTIONARIES)) {
    test(`project "${name}" has a label in ${code}`, () => {
      assert.ok(`evidence.project.${name}` in words, `missing evidence.project.${name}`);
    });
  }
}

// Every language's page shows each counted number as plain digits, with no thousands
// separator, since the same comma reads as a decimal point in some languages.
for (const code of Object.keys(DICTIONARIES)) {
  test(`${code}: the counted numbers show plain digits`, () => {
    const shown = code === "en" ? html : renderLanguage(html, code, DICTIONARIES[code]);
    const counts = [...shown.matchAll(/data-count="(\d+)"[^>]*>([^<]*)</g)];
    assert.ok(counts.length > 0, "no counted numbers on the page");
    for (const [, count, text] of counts) assert.equal(text, count);
  });
}

// The evidence section's totals are the sums of its per-project rows, so the big
// numbers cannot drift from the chart. Each project's counts also keep their order:
// fixed is within reviewed, and reviewed is within merged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { projects } from "../../page/evidence-data.js";

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

for (const { name, merged, reviewed, fixed } of projects) {
  test(`project "${name}": fixed <= reviewed <= merged`, () => {
    assert.ok(fixed <= reviewed, `fixed ${fixed} > reviewed ${reviewed}`);
    assert.ok(reviewed <= merged, `reviewed ${reviewed} > merged ${merged}`);
  });
}

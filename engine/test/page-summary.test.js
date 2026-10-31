// The page names every rule file in plain words; a rule without an entry
// would show its file name and no description.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../../page/summary.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rulesDir = join(repo, "_core", "project-template", ".claude", "rules");

test("every rule file has a plain name and line on the page", () => {
  const names = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  const files = names.map((name) => [`.claude/rules/${name}.md`, ""]);
  const rules = summarize(files).find((g) => g.id === "rules").rules;
  const unnamed = names.filter((name, i) => rules[i][1] === "");
  assert.deepEqual(unnamed, []);
});

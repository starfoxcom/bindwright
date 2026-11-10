// The template mods' user lists ship empty: each holds commands or rules for one person's
// projects and machine, and an entry left in the canonical file would run, or apply, on the
// computer of everyone who installs the mod. Read as text, since the mods are TypeScript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODS = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "_core", "global-template", "mods");

// Each row: the mod, its rules file, and the line that must read exactly as shipped.
const LISTS = [
  ["usage-guard stop commands", "usage-guard",
    /^export const STOP_COMMANDS: [^=]+= \{\}$/m],
  ["shared-pc per-project rules", "shared-pc", /^ {2}projects: \{\},$/m],
  ["runners list", "runners", /^export const RUNNERS: Runner\[\] = \[\]$/m],
];

for (const [name, mod, emptyLine] of LISTS) {
  test(`the ${name} ship empty`, () => {
    const text = readFileSync(join(MODS, mod, "hooks", "rules.ts"), "utf8").replace(/\r\n/g, "\n");
    assert.match(text, emptyLine, `${mod}/hooks/rules.ts must ship its user list empty`);
  });
}

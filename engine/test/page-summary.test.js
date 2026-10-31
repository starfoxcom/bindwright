// The page names every rule file in plain words; a rule without an entry
// would show its file name and no description. The cards also show what each
// answer changes, so one answer changing must always change the summary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../../page/summary.js";
import { bind } from "../bind.js";
import { defaults } from "../model.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(engine, "..");
const rulesDir = join(repo, "_core", "project-template", ".claude", "rules");
const coreFiles = JSON.parse(readFileSync(join(engine, "core-files.json"), "utf8"));
const readFile = async (path) => readFileSync(join(repo, path), "utf8");
const STAGING = ".bindwright/incoming/";
const HIDDEN = [".bindwright/pristine.json", ".bindwright/global/"];

// The cards for one answer set, from the files the engine would write.
async function cardsFor(answers) {
  const options = { readFile, coreFiles, year: 2026, version: "2.0.0" };
  const bound = await bind(structuredClone(answers), options);
  const files = [...bound]
    .filter(([dest]) => !HIDDEN.some((h) => dest.startsWith(h)))
    .map(([dest, text]) => [dest.startsWith(STAGING) ? dest.slice(STAGING.length) : dest, text]);
  return summarize(files, answers);
}

// What the cards show, without the file texts: each group's id, rules and facts.
const shape = (groups) => JSON.stringify(
  groups.map(({ id, rules = null, facts }) => [id, rules, facts]),
);

test("every rule file has a plain name and line on the page", () => {
  const names = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  const files = names.map((name) => [`.claude/rules/${name}.md`, ""]);
  const rules = summarize(files, defaults()).find((g) => g.id === "rules").rules;
  const unnamed = names.filter((name, i) => rules[i][1] === "");
  assert.deepEqual(unnamed, []);
});

// The eight answer sets: team, client and private, each on or off.
const COMBOS = [];
for (const team of [false, true]) {
  for (const client of [false, true]) {
    for (const isPrivate of [false, true]) COMBOS.push({ team, client, isPrivate });
  }
}
const label = ({ team, client, isPrivate }) => `team=${team} client=${client} private=${isPrivate}`;
const differsInOne = (a, b) => Object.keys(a).filter((key) => a[key] !== b[key]).length === 1;

const cardCache = new Map();
const cardsOf = (combo) => {
  const key = label(combo);
  if (!cardCache.has(key)) cardCache.set(key, cardsFor(defaults(combo)));
  return cardCache.get(key);
};

for (let i = 0; i < COMBOS.length; i++) {
  for (let j = i + 1; j < COMBOS.length; j++) {
    const [a, b] = [COMBOS[i], COMBOS[j]];
    if (!differsInOne(a, b)) continue;
    test(`the cards change when only one answer moves: ${label(a)} to ${label(b)}`, async () => {
      const [before, after] = await Promise.all([cardsOf(a), cardsOf(b)]);
      assert.notEqual(shape(before), shape(after));
    });
  }
}

// The license line on the project card, for each kind of project.
const LICENSE_ROWS = [
  ["own private project shows all rights reserved", { isPrivate: true },
    ["License: all rights reserved"]],
  ["own public project shows MIT", {}, ["License: MIT, free for anyone to reuse"]],
  ["someone else's project shows no license line", { client: true }, []],
];
for (const [name, options, expected] of LICENSE_ROWS) {
  test(name, async () => {
    const cards = await cardsFor(defaults(options));
    const project = cards.filter((g) => g.id === "project");
    const texts = project.flatMap((g) => g.facts.map((fact) => fact.text));
    const lines = texts.filter((text) => text.startsWith("License:"));
    assert.deepEqual(lines, expected);
  });
}

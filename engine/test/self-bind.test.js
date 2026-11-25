// This repo runs on its own setup: `.bindwright/pristine.json` records the render of `_core/` with the
// repo's saved answers. A change in `_core/` committed without `node engine/cli.js --update .` leaves the
// record behind the templates, and the next update would merge against stale text. This renders the
// templates the way the update does and checks the record matches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bind } from "../bind.js";
import { isOwned, ownedPatterns } from "../keep.js";
import { expandAnswers } from "../model.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(repo, path), "utf8");
const lf = (text) => text.replace(/\r\n/g, "\n");

test("the repo's bind record matches a fresh render of its templates", async () => {
  const pristine = JSON.parse(read(".bindwright/pristine.json"));
  const owned = ownedPatterns(existsSync(join(repo, ".bindwright/owned")) ? read(".bindwright/owned") : "");
  const coreFiles = JSON.parse(read("engine/core-files.json"));
  const version = read("VERSION").trim().replace(/^v+/, "");
  const answers = expandAnswers(JSON.parse(read(".bindwright/project.json")));
  const rendered = await bind(answers, { readFile: async (p) => read(p), coreFiles, year: pristine.year, version });
  const behind = [...rendered]
    // `.bindwright/` holds setup's own copies (global extras, staged files), which no update records.
    .filter(([path]) => !path.startsWith(".bindwright/") && !isOwned(path, owned))
    .filter(([path, text]) => typeof pristine.files[path] !== "string" || lf(pristine.files[path]) !== lf(text))
    .map(([path]) => path);
  assert.deepEqual(behind, [], "the templates changed without a re-bind: run `node engine/cli.js --update .`"
    + " and commit the result with .bindwright/pristine.json");
});

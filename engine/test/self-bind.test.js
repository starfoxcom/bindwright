// This repo runs on its own setup: `.bindwright/pristine.json` records the render of `_core/` with the
// repo's saved answers. A change in `_core/` committed without `node engine/cli.js --update .` leaves the
// record behind the templates, and the next update would merge against stale text. This plans the update
// the way `--update` does, writing nothing, and checks the record it would write is the one committed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bind } from "../bind.js";
import { ownedPatterns } from "../keep.js";
import { expandAnswers } from "../model.js";
import { planUpdate } from "../update.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(repo, path), "utf8");
const readRepo = (path) => (existsSync(join(repo, path)) ? read(path) : null);
const lf = (text) => (typeof text === "string" ? text.replace(/\r\n/g, "\n") : text);

test("the repo's bind record matches what an update would record", async () => {
  const pristine = JSON.parse(read(".bindwright/pristine.json"));
  const owned = ownedPatterns(readRepo(".bindwright/owned") ?? "");
  const coreFiles = JSON.parse(read("engine/core-files.json"));
  const version = read("VERSION").trim().replace(/^v+/, "");
  const answers = expandAnswers(JSON.parse(read(".bindwright/project.json")));
  const rendered = await bind(answers, { readFile: async (p) => read(p), coreFiles, year: pristine.year, version });
  // A file whose template changed is reported below before any merge result matters.
  const merge = () => ({ text: "", conflicts: true });
  const planned = planUpdate(rendered, pristine, { readRepo, owned, merge, version }).pristine.files;
  // A file `--keep-base` held back for a later PR keeps its old base, with the new render under `held`.
  const held = pristine.held ?? {};
  const paths = [...new Set([...Object.keys(pristine.files), ...Object.keys(planned)])].sort();
  const isHeld = (path) => typeof held[path] === "string" && lf(held[path]) === lf(planned[path]);
  const behind = paths.filter((path) => lf(pristine.files[path]) !== lf(planned[path]) && !isHeld(path));
  assert.deepEqual(behind, [], "the templates changed without a re-bind: run `node engine/cli.js --update .`"
    + " and commit the result with .bindwright/pristine.json");
});

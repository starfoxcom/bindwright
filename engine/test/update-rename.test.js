// /bindwright:update when the templates renamed a file: the move carries the repo's edits,
// and a path the project owns is never moved into or out of.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { RENAMES } from "../update.js";
import { PRISTINE, STAGING, makeRepo } from "./bound-repo.js";
import { python } from "./python.js";
import { needsPython, engines } from "./update-run.js";

// A repo set up before the session skills were renamed, one of them edited.
function beforeRename(r) {
  for (const [from, to] of Object.entries(RENAMES)) {
    const old = r.read(to).replace(/start-session/g, "session-start").replace(/close-session/g, "session-close");
    r.pristine.files[from] = old;
    delete r.pristine.files[to];
    rmSync(r.at(dirname(to)), { recursive: true, force: true });
    r.write(from, from.includes("start") ? `${old}MINE\n` : old);
  }
}

test("a renamed skill moves to its new path with the repo's edits", needsPython, async () => {
  const [[closeFrom, closeTo], [startFrom, startTo]] = Object.entries(RENAMES);
  const results = [];
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    const repo = await makeRepo(beforeRename);
    const theirs = await makeRepo(() => {});
    const out = JSON.parse(spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" }).stdout);
    assert.deepEqual(out.renamed, [[closeFrom, closeTo], [startFrom, startTo]], cmd);
    assert.ok(out.updated.includes(closeTo) && out.merged.includes(startTo), cmd);
    assert.equal(repo.read(closeTo), theirs.read(closeTo), cmd);
    assert.equal(repo.read(startTo), `${theirs.read(startTo)}MINE\n`, cmd);
    for (const from of [closeFrom, startFrom]) assert.ok(!existsSync(repo.at(dirname(from))), `${cmd}: ${from}`);
    const saved = JSON.parse(repo.read(PRISTINE)).files;
    assert.ok(!(closeFrom in saved) && startTo in saved, cmd);
    results.push(out);
    for (const r of [repo, theirs]) rmSync(r.at(""), { recursive: true, force: true });
  }
  if (results.length === 2) assert.deepEqual(results[1], results[0], "the two engines report alike");
});

test("a renamed skill whose staged copy is still unsettled keeps its old base", needsPython, async () => {
  const startTo = Object.values(RENAMES).find((to) => to.includes("start"));
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    let base;
    const repo = await makeRepo((r) => {
      beforeRename(r);
      const startFrom = Object.keys(RENAMES).find((from) => from.includes("start"));
      base = r.pristine.files[startFrom];
      r.write(startFrom, r.read(startFrom).replace("name: session-start", "name: my-start"));
      r.write(`${STAGING}${startTo}`, "left from the last update\n");
    });
    const out = JSON.parse(spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" }).stdout);
    assert.ok(out.skipped.includes(startTo), `${cmd}: ${JSON.stringify(out)}`);
    assert.equal(JSON.parse(repo.read(PRISTINE)).files[startTo], base, cmd);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
});

test("a project that owns the old skill path keeps only its own copy", needsPython, async () => {
  const [[closeFrom, closeTo]] = Object.entries(RENAMES);
  const claims = [
    ["the old path", closeFrom, true],
    ["the whole skills folder", ".claude/skills/", true],
    ["the old path, its base already lost", closeFrom, false],
  ];
  for (const [claim, line, keptBase] of claims) {
    const outs = [];
    for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
      const where = `${cmd}, ${claim}`;
      const repo = await makeRepo((r) => {
        beforeRename(r);
        r.write(".bindwright/owned", `${line}\n`);
        if (!keptBase) {
          r.pristine.files[closeTo] = r.pristine.files[closeFrom];
          delete r.pristine.files[closeFrom];
        }
      });
      const run = () => JSON.parse(spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" }).stdout);
      const out = run();
      assert.ok(out.owned.includes(closeTo) && out.owned.includes(closeFrom) === keptBase, where);
      assert.ok(existsSync(repo.at(closeFrom)) && !existsSync(repo.at(closeTo)), where);
      outs.push(out);
      // Once the project drops its claim, the skill arrives: moved with the
      // project's edits when the base was kept, added beside its copy when not.
      rmSync(repo.at(".bindwright/owned"));
      const after = run();
      const moved = after.renamed.some(([from, to]) => from === closeFrom && to === closeTo);
      assert.equal(moved, keptBase, where);
      assert.ok(keptBase ? !existsSync(repo.at(closeFrom)) : after.added.includes(closeTo), where);
      assert.ok(existsSync(repo.at(closeTo)), where);
      rmSync(repo.at(""), { recursive: true, force: true });
    }
    if (outs.length === 2) assert.deepEqual(outs[1], outs[0], `the two engines report alike, ${claim}`);
  }
});

test("a renamed skill deleted under a folder claim stays deleted once the claim is dropped", needsPython, async () => {
  const [[, closeTo]] = Object.entries(RENAMES);
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    const repo = await makeRepo((r) => {
      rmSync(r.at(dirname(closeTo)), { recursive: true, force: true });
      r.write(".bindwright/owned", ".claude/skills/\n");
    });
    const run = () => JSON.parse(spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" }).stdout);
    run();
    rmSync(repo.at(".bindwright/owned"));
    const after = run();
    assert.ok(after.deleted.includes(closeTo) && !existsSync(repo.at(closeTo)), `${cmd}: ${JSON.stringify(after)}`);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
});

test("a move into a path the project owns is not made, and the old file is reported", needsPython, async () => {
  const [[closeFrom, closeTo], [startFrom, startTo]] = Object.entries(RENAMES);
  const outs = [];
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    const repo = await makeRepo((r) => {
      beforeRename(r);
      r.write(".bindwright/owned", `${closeTo}\n`);
    });
    const out = JSON.parse(spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" }).stdout);
    assert.deepEqual(out.renamed, [[startFrom, startTo]], cmd);
    assert.ok(out.owned.includes(closeTo) && out.removed.includes(closeFrom), cmd);
    assert.ok(existsSync(repo.at(closeFrom)), cmd);
    outs.push(out);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
  if (outs.length === 2) assert.deepEqual(outs[1], outs[0], "the two engines report alike");
});

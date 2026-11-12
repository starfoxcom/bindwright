// /bindwright:update on throwaway repos: each case binds a repo, changes its
// files or its saved pristine render, then runs both engines' --update on
// identical copies. Both must report the same outcome and leave the same
// bytes; the case then checks what the outcome should be.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, cpSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planUpdate, MERGE_LABELS, RENAMES } from "../update.js";
import { PRISTINE, STAGING, makeRepo } from "./bound-repo.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = ".claude/rules/task-tracking.md";
const OTHER = ".claude/rules/testing.md";
const THIRD = ".claude/rules/git.md";

const needsPython = { skip: !python && "needs Python 3.8+" };
const engines = [[process.execPath, [join(engine, "cli.js")]], [python, [join(engine, "bind.py")]]];

// Both engines on identical copies; returns the JS repo and its report.
async function update(change) {
  const runs = [];
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    const repo = await makeRepo(change);
    const out = spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" });
    runs.push({ repo, out: JSON.parse(out.stdout), status: out.status });
  }
  if (runs.length === 2) {
    assert.deepEqual(runs[1].out, runs[0].out, "the two engines report alike");
    for (const p of [PRISTINE, RULE, OTHER, THIRD, `.bindwright/incoming/${RULE}`]) {
      assert.equal(runs[1].repo.peek(p), runs[0].repo.peek(p), `${p} is the same from both engines`);
    }
  }
  for (const r of runs.slice(1)) rmSync(r.repo.at(""), { recursive: true, force: true });
  return runs[0];
}

// The saved render as if the templates used to lack the file's last line.
const older = (text) => text.replace(/\n[^\n]+\n$/, "\n");

test("nothing changed: every file is unchanged and the version moves on", needsPython, async () => {
  const { out, repo } = await update(() => {});
  assert.ok(out.unchanged.includes(RULE));
  const moved = ["updated", "merged", "added", "staged", "conflict", "deleted", "removed"];
  for (const o of moved) assert.deepEqual(out[o], [], o);
  assert.notEqual(JSON.parse(repo.read(PRISTINE)).version, "0.0.1");
  assert.equal(JSON.parse(repo.read(PRISTINE)).year, 2026);
});

test("Windows line endings on disk read as the same file", needsPython, async () => {
  const { out } = await update((r) => r.write(RULE, r.read(RULE).replace(/\n/g, "\r\n")));
  assert.ok(out.unchanged.includes(RULE));
});

test("a template change reaches an untouched file", needsPython, async () => {
  let theirs;
  const { out, repo } = await update((r) => {
    theirs = r.read(RULE);
    r.pristine.files[RULE] = older(theirs);
    r.write(RULE, older(theirs));
  });
  assert.deepEqual(out.updated, [RULE]);
  assert.equal(repo.read(RULE), theirs);
});

test("a hand edit survives a template change elsewhere in the file", needsPython, async () => {
  let theirs;
  const { out, repo } = await update((r) => {
    theirs = r.read(RULE);
    r.pristine.files[RULE] = older(theirs);
    r.write(RULE, `MINE\n${older(theirs)}`);
  });
  assert.deepEqual(out.merged, [RULE]);
  assert.equal(repo.read(RULE), `MINE\n${theirs}`);
});

// The first line changed three ways: the old templates, the repo, today's.
function clash(r) {
  const theirs = r.read(RULE);
  const first = theirs.split("\n")[0];
  r.pristine.files[RULE] = theirs.replace(first, `${first} (old)`);
  r.write(RULE, theirs.replace(first, `${first} (mine)`));
  return theirs;
}

test("a real conflict leaves the file alone and stages it with all three versions", needsPython, async () => {
  let ours, theirs;
  const { out, repo } = await update((r) => {
    theirs = clash(r);
    ours = r.read(RULE);
  });
  assert.deepEqual(out.conflict, [RULE]);
  assert.equal(repo.read(RULE), ours);
  const marked = repo.read(`.bindwright/incoming/${RULE}`);
  for (const label of MERGE_LABELS) assert.ok(marked.includes(label), label);
  assert.match(marked, /\(mine\)[\s\S]*\(old\)/);
  assert.equal(JSON.parse(repo.read(PRISTINE)).files[RULE], theirs);
});

test("a conflict the user settled by keeping their line does not come back", needsPython, async () => {
  for (const [cmd, args] of engines) {
    const repo = await makeRepo(clash);
    const run = () => JSON.parse(spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" }).stdout);
    assert.deepEqual(run().conflict, [RULE]);
    rmSync(repo.at(STAGING), { recursive: true, force: true });
    const again = run();
    assert.deepEqual(again.conflict, [], cmd);
    assert.ok(again.unchanged.includes(RULE), cmd);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
});

test("owned files and kept sections stay the project's", needsPython, async () => {
  const kept = "<!-- bindwright:keep -->\nOURS ONLY\n<!-- bindwright:end-keep -->\n";
  const { out, repo } = await update((r) => {
    r.write(".bindwright/owned", `${OTHER}\n`);
    r.pristine.files[OTHER] = older(r.read(OTHER));
    r.write(OTHER, "project's own\n");
    clash(r);
    r.write(RULE, `${r.pristine.files[RULE]}${kept}`);
  });
  assert.deepEqual(out.owned, [OTHER]);
  assert.equal(repo.read(OTHER), "project's own\n");
  assert.deepEqual(out.merged, [RULE]);
  assert.ok(repo.read(RULE).endsWith(kept));
});

test("new, dropped and deleted files each get their own outcome", needsPython, async () => {
  let third;
  const { out, repo } = await update((r) => {
    delete r.pristine.files[RULE]; // new in the templates, and the repo has it
    r.write(RULE, "the repo's own copy\n");
    third = r.read(THIRD); // new in the templates, and the repo lacks it
    delete r.pristine.files[THIRD];
    rmSync(r.at(THIRD));
    r.pristine.files["docs/gone.md"] = "old\n"; // dropped from the templates
    r.write("docs/gone.md", "old\n");
    r.pristine.files["docs/edited.md"] = "old\n";
    r.write("docs/edited.md", "changed\n");
    r.pristine.files["docs/both-gone.md"] = "old\n"; // dropped, and the repo had already deleted it
    rmSync(r.at(OTHER)); // the repo deleted a file the bind wrote
  });
  assert.deepEqual(out.added, [THIRD]);
  assert.equal(repo.read(THIRD), third);
  assert.deepEqual(out.staged, [RULE]);
  assert.deepEqual(out.skipped, []);
  assert.equal(repo.read(RULE), "the repo's own copy\n");
  assert.ok(existsSync(repo.at(`.bindwright/incoming/${RULE}`)));
  assert.deepEqual(out.removed, ["docs/gone.md"]);
  assert.deepEqual(out.removed_edited, ["docs/edited.md"]);
  assert.deepEqual(out.deleted, [OTHER, "docs/both-gone.md"]);
  assert.ok(!existsSync(repo.at(OTHER)));
});

test("a staged copy left from before is kept, not overwritten", needsPython, async () => {
  const { out, repo } = await update((r) => {
    delete r.pristine.files[RULE];
    r.write(RULE, "the repo's own copy\n");
    r.write(`.bindwright/incoming/${RULE}`, "staged last time\n");
  });
  assert.deepEqual(out.skipped, [RULE]);
  assert.equal(repo.read(`.bindwright/incoming/${RULE}`), "staged last time\n");
  // Still new to the repo, so the next update stages it again.
  assert.ok(!(RULE in JSON.parse(repo.read(PRISTINE)).files));
});

test("an unsettled conflict keeps its old base until its staged copy is gone", needsPython, async () => {
  for (const [cmd, args] of python ? engines : []) {
    const repo = await makeRepo((r) => {
      clash(r);
      r.write(`.bindwright/incoming/${RULE}`, "settled later\n");
    });
    const run = () => JSON.parse(spawnSync(cmd, [...args, "--update", repo.at("")], { encoding: "utf8" }).stdout);
    assert.deepEqual(run().skipped, [RULE], cmd);
    assert.match(JSON.parse(repo.read(PRISTINE)).files[RULE], /\(old\)/, cmd);
    rmSync(repo.at(STAGING), { recursive: true, force: true });
    assert.deepEqual(run().conflict, [RULE], cmd);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
});

// Symbolic links need extra rights on Windows; the cases skip where they cannot be made.
const linksWork = (() => {
  const dir = mkdtempSync(join(tmpdir(), "update-link-"));
  try {
    symlinkSync(join(dir, "nowhere"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const needsLinks = { skip: !(python && linksWork) && "needs Python 3.8+ and symbolic links" };

test("a write through a symbolic link is refused before anything is written", needsLinks, async () => {
  const outside = mkdtempSync(join(tmpdir(), "update-outside-"));
  try {
    let before, target;
    const { out, status, repo } = await update((r) => {
      // The link reads as the old render, so the file would take the new text.
      target = older(r.read(RULE));
      writeFileSync(join(outside, "target.md"), target);
      r.pristine.files[RULE] = target;
      before = older(r.read(OTHER));
      r.pristine.files[OTHER] = before;
      r.write(OTHER, before); // would update cleanly
      rmSync(r.at(RULE));
      symlinkSync(join(outside, "target.md"), r.at(RULE));
    });
    assert.equal(status, 1);
    assert.equal(out.error, `Refusing to write through a symbolic link: ${RULE}`);
    assert.equal(readFileSync(join(outside, "target.md"), "utf8"), target);
    assert.equal(JSON.parse(repo.read(PRISTINE)).version, "0.0.1");
    assert.equal(repo.read(OTHER), before, "no other file was written either");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a write through a linked .claude folder is refused, naming the folder", needsLinks, async () => {
  const outside = mkdtempSync(join(tmpdir(), "update-outside-"));
  try {
    let target;
    const { out, status, repo } = await update((r) => {
      // The file reads as the old render through the link, so it would take the new text.
      target = older(r.read(RULE));
      r.pristine.files[RULE] = target;
      r.write(RULE, target);
      cpSync(r.at(".claude"), outside, { recursive: true });
      rmSync(r.at(".claude"), { recursive: true, force: true });
      symlinkSync(outside, r.at(".claude"), "junction");
    });
    assert.equal(status, 1);
    assert.equal(out.error, "Refusing to write through a symbolic link: .claude");
    assert.equal(readFileSync(join(outside, "rules", "task-tracking.md"), "utf8"), target);
    assert.equal(JSON.parse(repo.read(PRISTINE)).version, "0.0.1");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a linked pristine.json is refused, not written through", needsLinks, async () => {
  const outside = mkdtempSync(join(tmpdir(), "update-outside-"));
  try {
    let saved;
    const { out, status } = await update((r) => {
      saved = `${JSON.stringify(r.pristine, null, 2)}\n`;
      writeFileSync(join(outside, "pristine.json"), saved);
      rmSync(r.at(PRISTINE));
      symlinkSync(join(outside, "pristine.json"), r.at(PRISTINE));
    });
    assert.equal(status, 1);
    assert.equal(out.error, `Refusing to write through a symbolic link: ${PRISTINE}`);
    assert.equal(readFileSync(join(outside, "pristine.json"), "utf8"), saved);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a dangling link where a staged copy goes counts as an old copy", needsLinks, async () => {
  const { out } = await update((r) => {
    delete r.pristine.files[RULE];
    r.write(RULE, "the repo's own copy\n");
    mkdirSync(dirname(r.at(`${STAGING}${RULE}`)), { recursive: true });
    symlinkSync(r.at("nowhere.md"), r.at(`${STAGING}${RULE}`));
  });
  assert.deepEqual(out.skipped, [RULE]);
});

test("a file that is not UTF-8 stops the update instead of being written back", needsPython, async () => {
  const latin1 = Buffer.from("caf\xe9\n", "latin1");
  const { out, status, repo } = await update((r) => {
    const theirs = r.read(RULE);
    r.pristine.files[RULE] = older(theirs);
    writeFileSync(r.at(RULE), Buffer.concat([Buffer.from(older(theirs)), latin1]));
  });
  assert.equal(status, 1);
  assert.equal(out.error, `${RULE} is not UTF-8 text`);
  assert.ok(readFileSync(repo.at(RULE)).subarray(-latin1.length).equals(latin1));
});

test("a lone carriage return survives a merge in both engines", needsPython, async () => {
  const { out, repo } = await update((r) => {
    const theirs = r.read(RULE);
    r.pristine.files[RULE] = older(theirs);
    r.write(RULE, `mine\rstill mine\n${older(theirs)}`);
  });
  assert.deepEqual(out.merged, [RULE]);
  assert.ok(repo.read(RULE).startsWith("mine\rstill mine\n"));
});

test("paths sort by UTF-16 code unit in both engines", needsPython, async () => {
  const { out } = await update((r) => {
    for (const name of ["docs/ł.md", "docs/a.md", "docs/\u{1f600}.md", "docs/Ａ.md"]) {
      r.pristine.files[name] = "old\n";
      r.write(name, "old\n");
    }
  });
  assert.deepEqual(out.removed, ["docs/a.md", "docs/ł.md", "docs/\u{1f600}.md", "docs/Ａ.md"]);
});

test("a repo that was never set up is refused", needsPython, async () => {
  const { out, status } = await update((r) => rmSync(r.at(".bindwright/project.json")));
  assert.equal(status, 1);
  assert.match(out.error, /was not set up with \/bindwright:setup/);
});

test("a state file that is a folder is refused with the same words in both engines", needsPython, async () => {
  const { out, status } = await update((r) => {
    rmSync(r.at(".bindwright/project.json"));
    mkdirSync(r.at(".bindwright/project.json"));
  });
  assert.equal(status, 1);
  assert.equal(out.error, ".bindwright/project.json cannot be read (it is a folder)");
});

test("a saved path outside the repo is refused before anything is written", needsPython, async () => {
  const { out, status, repo } = await update((r) => {
    r.pristine.files["../escape.md"] = "x\n";
  });
  assert.equal(status, 1);
  assert.match(out.error, /Refusing paths outside the repo/);
  assert.equal(JSON.parse(repo.read(PRISTINE)).version, "0.0.1");
});

test("answers saved before a key was added still update cleanly", needsPython, async () => {
  const { out, status } = await update((r) => {
    const answers = JSON.parse(r.read(".bindwright/project.json"));
    delete answers.advanced.trackerRepo;
    r.write(".bindwright/project.json", `${JSON.stringify(answers, null, 2)}\n`);
  });
  assert.equal(status, 0, out.error);
  assert.equal(out.error, undefined);
});

test("a merge that drops a kept section counts as a conflict", () => {
  const kept = "a\n# bindwright:keep\nmine\n# bindwright:end-keep\n";
  const rendered = new Map([["x.py", "b\n"]]);
  const plan = planUpdate(rendered, { year: 2026, files: { "x.py": "a\n" } }, {
    readRepo: () => kept, owned: [], version: "1", merge: () => ({ text: "b\n", conflicts: 0 }),
  });
  assert.deepEqual(plan.conflict, ["x.py"]);
  assert.deepEqual(plan.write, []);
  assert.deepEqual(plan.stage, [[`${STAGING}x.py`, "b\n"]]);
});

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

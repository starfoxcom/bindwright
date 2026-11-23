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
import { planUpdate, gitMerge, MERGE_LABELS, RENAMES } from "../update.js";
import { PRISTINE, STAGING, makeRepo } from "./bound-repo.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = ".claude/rules/task-tracking.md";
const OTHER = ".claude/rules/testing.md";
const THIRD = ".claude/rules/git.md";
const LICENSE = "LICENSE";
const SETTINGS = ".claude/settings.json";

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
    for (const p of [PRISTINE, RULE, OTHER, THIRD, SETTINGS, STAGING + RULE, STAGING + OTHER]) {
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

// THIRD is owned too, with no template change since the last update, so only OTHER is reported as changed.
test("owned files and kept sections stay the project's", needsPython, async () => {
  const kept = "<!-- bindwright:keep -->\nOURS ONLY\n<!-- bindwright:end-keep -->\n";
  let theirs;
  const { out, repo } = await update((r) => {
    r.write(".bindwright/owned", `${OTHER}\n${THIRD}\n`);
    theirs = r.read(OTHER);
    r.pristine.files[OTHER] = older(theirs);
    r.write(OTHER, "project's own\n");
    clash(r);
    r.write(RULE, `${r.pristine.files[RULE]}${kept}`);
  });
  assert.deepEqual([...out.owned].sort(), [OTHER, THIRD].sort());
  assert.deepEqual(out.owned_changed, [OTHER]);
  assert.equal(repo.read(OTHER), "project's own\n");
  assert.equal(repo.peek(STAGING + OTHER), theirs, "the new text waits to be settled");
  assert.equal(repo.peek(STAGING + THIRD), null);
  assert.deepEqual(out.merged, [RULE]);
  assert.ok(repo.read(RULE).endsWith(kept));
  // A second update before anyone settles it leaves the waiting copy where it is.
  spawnSync(engines[0][0], [...engines[0][1], "--update", repo.at("")], { encoding: "utf8" });
  assert.equal(repo.peek(STAGING + OTHER), theirs);
  assert.equal(repo.read(OTHER), "project's own\n");
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

test("a file held back for a later PR keeps its old base, so the next update offers it", needsPython, async () => {
  const outs = [];
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    let today;
    const repo = await makeRepo((r) => {
      today = r.read(RULE);
      r.pristine.files[RULE] = older(today);
      r.write(RULE, older(today));
    });
    const run = (flags, input) =>
      JSON.parse(spawnSync(cmd, [...args, ...flags], { encoding: "utf8", input }).stdout);
    const early = run(["--keep-base", repo.at("")], JSON.stringify({ paths: [RULE] }));
    assert.match(early.error, /No record from before the last update/, cmd);
    // A record that cannot be saved stops the update before it writes anything.
    const blocker = repo.at(".git/bindwright-pristine-before.json");
    mkdirSync(blocker);
    const [ruleBefore, pristineBefore] = [repo.read(RULE), repo.read(PRISTINE)];
    assert.ok(run(["--update", repo.at("")]).error, `${cmd}: an unsavable record is an error`);
    assert.deepEqual([repo.read(RULE), repo.read(PRISTINE)], [ruleBefore, pristineBefore], `${cmd}: nothing written`);
    rmSync(blocker, { recursive: true });
    // The update moves the file's base to today's text; the file itself is then held back.
    assert.ok(run(["--update", repo.at("")]).updated.includes(RULE), cmd);
    repo.write(RULE, older(today));
    const moved = JSON.parse(repo.read(PRISTINE));
    delete moved.files[OTHER]; // as an update records a file the templates dropped
    repo.write(PRISTINE, JSON.stringify(moved));
    const kept = run(["--keep-base", repo.at("")], JSON.stringify({ paths: [RULE, OTHER, "docs/new.md"] }));
    assert.deepEqual(kept, { kept: [RULE, OTHER], dropped: ["docs/new.md"] }, cmd);
    const order = Object.keys(JSON.parse(repo.read(PRISTINE)).files);
    assert.deepEqual(order, [...order].sort(), `${cmd}: a base put back lands at its sorted place`);
    assert.ok(run(["--update", repo.at("")]).updated.includes(RULE), `${cmd}: the held-back change comes again`);
    // Names an object inherits in JavaScript are plain paths, and a record with no files is refused.
    const inherited = run(["--keep-base", repo.at("")], JSON.stringify({ paths: ["constructor", "__proto__"] }));
    const afterInherited = repo.read(PRISTINE);
    repo.write(PRISTINE, "[]");
    const broken = run(["--keep-base", repo.at("")], JSON.stringify({ paths: [] }));
    outs.push({ early, kept, inherited, afterInherited, broken });
    rmSync(repo.at(""), { recursive: true, force: true });
  }
  assert.deepEqual(outs[0].inherited, { kept: [], dropped: ["constructor", "__proto__"] });
  assert.match(outs[0].broken.error, /holds no record of the files setup wrote/);
  if (outs.length === 2) assert.deepEqual(outs[1], outs[0], "the two engines report and write alike");
});

// One later-PR round for LICENSE on one engine. The update moves the file to this year's text and
// --keep-base holds that text back. The repo then holds edit(this year's text), and the saved year
// moves on to 2027, so the next update renders a new text. `dropHeld` removes the held text before
// that update, as a record from before the held text existed would. `holds` lists the path sets of
// each --keep-base call.
async function heldRound(cmd, args, { edit = (text) => text, dropHeld = false, holds = [[LICENSE]] } = {}) {
  const run = (flags, input) => JSON.parse(spawnSync(cmd, [...args, ...flags], { encoding: "utf8", input }).stdout);
  let today;
  const repo = await makeRepo((r) => {
    today = r.read(LICENSE);
    r.pristine.files[LICENSE] = today.replaceAll("2026", "2025");
    r.write(LICENSE, r.pristine.files[LICENSE]);
  });
  assert.ok(run(["--update", repo.at("")]).updated.includes(LICENSE), cmd);
  for (const paths of holds) run(["--keep-base", repo.at("")], JSON.stringify({ paths }));
  const kept = JSON.parse(repo.read(PRISTINE));
  repo.write(LICENSE, edit(today));
  const next = { ...kept, year: 2027 };
  if (dropHeld) delete next.held;
  repo.write(PRISTINE, JSON.stringify(next));
  const out = run(["--update", repo.at("")]);
  const round = { today, kept, out, license: repo.read(LICENSE), record: repo.read(PRISTINE) };
  rmSync(repo.at(""), { recursive: true, force: true });
  return round;
}

test("a file held back for a later PR takes its held text as the base once the repo has it", needsPython, async () => {
  const rounds = [];
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    // Listed twice in one call, then held again: the first hold's text stays.
    const round = await heldRound(cmd, args, { holds: [[LICENSE, LICENSE], [LICENSE]] });
    assert.equal(round.kept.held[LICENSE], round.today, `${cmd}: the newer text is held`);
    assert.equal(round.kept.files[LICENSE], round.today.replaceAll("2026", "2025"), `${cmd}: the old base is back`);
    assert.ok(round.out.updated.includes(LICENSE), `${cmd}: ${JSON.stringify(round.out)}`);
    assert.equal(round.license, round.today.replaceAll("2026", "2027"), cmd);
    assert.equal(JSON.parse(round.record).held, undefined, `${cmd}: the new record holds nothing back`);
    rounds.push(round);
  }
  if (rounds.length === 2) assert.deepEqual(rounds[1], rounds[0], "the two engines report and write alike");
});

test("a file held back again after its template moved keeps the base the update used", needsPython, async () => {
  const outs = [];
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    const run = (flags, input) => JSON.parse(spawnSync(cmd, [...args, ...flags], { encoding: "utf8", input }).stdout);
    let today;
    const repo = await makeRepo((r) => {
      today = r.read(LICENSE);
      r.pristine.files[LICENSE] = today.replaceAll("2026", "2025");
      r.write(LICENSE, r.pristine.files[LICENSE]);
    });
    const at = (year) => today.replaceAll("2026", String(year));
    // Restore the repo's copy, as the skill does, then hold the file back.
    const holdBack = (text) => {
      repo.write(LICENSE, text);
      run(["--keep-base", repo.at("")], JSON.stringify({ paths: [LICENSE] }));
    };
    run(["--update", repo.at("")]);
    holdBack(at(2025));
    repo.write(LICENSE, at(2026)); // the later PR ships the held-back text
    repo.write(PRISTINE, JSON.stringify({ ...JSON.parse(repo.read(PRISTINE)), year: 2027 }));
    assert.ok(run(["--update", repo.at("")]).updated.includes(LICENSE), cmd);
    holdBack(at(2026));
    assert.equal(JSON.parse(repo.read(PRISTINE)).files[LICENSE], at(2026), `${cmd}: the base the update used`);
    const out = run(["--update", repo.at("")]);
    assert.ok(out.updated.includes(LICENSE), `${cmd}: ${JSON.stringify(out)}`);
    outs.push(out);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
  if (outs.length === 2) assert.deepEqual(outs[1], outs[0], "the two engines report alike");
});

test("a held text the repo has changed is not taken as the base", needsPython, async () => {
  const edit = (text) => `${text}Our own line.\n`;
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    const withHeld = await heldRound(cmd, args, { edit });
    const withoutHeld = await heldRound(cmd, args, { edit, dropHeld: true });
    assert.ok(!withHeld.out.updated.includes(LICENSE), cmd);
    assert.deepEqual(withHeld.out, withoutHeld.out, `${cmd}: the same outcome as before the held text`);
    assert.equal(withHeld.license, withoutHeld.license, cmd);
  }
});

// The settings with the first hook's timeout at a value the templates no longer have.
const olderTimeout = (text) => text.replace(/"timeout": \d+/, '"timeout": 5');
const firstTimeout = (text) => JSON.parse(text).hooks.PreToolUse[0].hooks[0].timeout;

// The same settings with the hooks key moved to the end, and nothing else changed.
function reordered(text) {
  const { hooks, ...rest } = JSON.parse(text);
  return `${JSON.stringify({ ...rest, hooks }, null, 2)}\n`;
}

test("a repo that moved its hooks key merges key by key", needsPython, async () => {
  let base, ours, theirs;
  const { out, repo } = await update((r) => {
    theirs = r.read(SETTINGS);
    base = olderTimeout(theirs);
    ours = reordered(base);
    r.pristine.files[SETTINGS] = base;
    r.write(SETTINGS, ours);
  });
  assert.ok(gitMerge(ours, base, theirs).conflicts > 0, "git's line merge clashes on these texts");
  assert.deepEqual(out.merged, [SETTINGS]);
  const merged = repo.read(SETTINGS);
  assert.deepEqual(Object.keys(JSON.parse(merged)), Object.keys(JSON.parse(ours)));
  assert.equal(firstTimeout(merged), firstTimeout(theirs));
  assert.equal(merged.match(/^ {2}"hooks": /gm).length, 1);
});

// Each row turns the moved-hooks copy into one the key merge must leave a conflict.
const atTop = (line) => (text) => text.replace("{\n", `{\n  ${line},\n`);
const STAYS_CONFLICT = {
  "a key both sides changed differently": (text) => text.replace(/"timeout": \d+/, '"timeout": 99'),
  "a repo copy that is not valid JSON": (text) => text.replace(/\n\}\n$/, ",\n}\n"),
  "a key repeated in its object": atTop('"//": "one",\n  "//": "two"'),
  "an object nested past the depth both twins read": atTop(`"deep": ${"[".repeat(65)}${"]".repeat(65)}`),
  "an integer past 2^53": atTop('"big": 9007199254740993'),
  "an all-digit key JavaScript moves first": atTop('"10": true'),
  "an escape of half a surrogate pair": atTop('"s": "\\ud800"'),
  "an indent longer than 10 characters": (text) => text.replace(/^ +/gm, (spaces) => spaces.repeat(6)),
  "a kept section the templates change": (text) => text
    .replace('  "hooks": ', '  "//keep": "bindwright:keep",\n  "hooks": ')
    .replace(/\n\}\n$/, ',\n  "//end": "bindwright:end-keep"\n}\n'),
};

// Text both twins read and reprint alike; update() compares the two engines' bytes.
const MERGES_ALIKE = {
  "a number written with a fraction": atTop('"ratio": 1.0'),
  "a carriage return between tokens": (text) => text.replace("{\n", "{\r \n"),
};

test("the key merge takes plain JSON and leaves the rest a conflict", needsPython, async () => {
  const rows = [
    ...Object.entries(STAYS_CONFLICT).map(([name, change]) => [name, change, "conflict"]),
    ...Object.entries(MERGES_ALIKE).map(([name, change]) => [name, change, "merged"]),
  ];
  for (const [name, change, outcome] of rows) {
    const { out } = await update((r) => {
      const base = olderTimeout(r.read(SETTINGS));
      r.pristine.files[SETTINGS] = base;
      r.write(SETTINGS, change(reordered(base)));
    });
    assert.deepEqual(out[outcome], [SETTINGS], name);
  }
});

// /bindwright:update on throwaway repos: each case binds a repo, changes its
// files or its saved pristine render, then runs both engines' --update on
// identical copies. Both must report the same outcome and leave the same
// bytes; the case then checks what the outcome should be.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { planUpdate, MERGE_LABELS } from "../update.js";
import { PRISTINE, STAGING, makeRepo } from "./bound-repo.js";
import { python } from "./python.js";
import { RULE, OTHER, THIRD, needsPython, engines, update, older } from "./update-run.js";

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

// Docs the bind ships, which a row deletes from the repo so its name has nothing to resolve to.
const GUIDE = "docs/ci-watching.md";
const AUDIT = "docs/test-audit.md";
// Deletes repo files the bind wrote; the record keeps them, so the update leaves them deleted.
const drop = (r, ...paths) => {
  for (const path of paths) rmSync(r.at(path), { recursive: true, force: true });
};

// Each row adds one line to the rule's template and checks the report's `missing` key.
// `base` is a line the saved record and the repo already hold before the update; `gone` lists
// shipped paths the repo deleted.
const NAMED_ROWS = [
  { name: "a path at the repo root is found", line: "See `.claude/settings.json`.", missing: [] },
  {
    name: "a shipped file the repo lacks is reported",
    gone: [GUIDE],
    line: `See \`${GUIDE}\`.`,
    missing: [{ file: RULE, names: [GUIDE] }],
  },
  {
    name: "a name repeated in the new text is reported once",
    gone: [GUIDE],
    line: `See \`${GUIDE}\` and \`${GUIDE}\`.`,
    missing: [{ file: RULE, names: [GUIDE] }],
  },
  {
    name: "a span the base text already names is not reported",
    gone: [GUIDE],
    base: `Old \`${GUIDE}\` wording.`,
    line: `New \`${GUIDE}\` wording.`,
    missing: [],
  },
  {
    name: "a shipped folder the repo lacks is reported",
    gone: ["docs"],
    line: "See `docs/`.",
    missing: [{ file: RULE, names: ["docs/"] }],
  },
  {
    name: "names the bind does not ship are never reported",
    line: "Set `content.type` and `gorm.DB`; lay out `cart/index.ts` and `auth/`; create " +
      "`docs/never-written.md`; skip `<path>/x.md`, `https://example.com/a.md`, " +
      "`feature/user-auth-flow`, `7.19.1`, `..\\..\\x.md`, `\\\\host\\share\\x.md` and `C:x.md`.",
    missing: [],
  },
];

// The task-tracking template with `line` added at its end.
const addLine = (line) => (text) => `${text}\n${line}\n`;
// Makes `line` a line that the saved record and the repo both hold.
const withBase = (line) => (r) => {
  const base = `${r.read(RULE)}\n${line}\n`;
  r.pristine.files[RULE] = base;
  r.write(RULE, base);
};
// Owns the testing rule in the repo, with a copy that lacks its "Testing" heading.
const ownTesting = (r) => {
  r.write(".bindwright/owned", `${OTHER}\n`);
  r.write(OTHER, "# Other\n");
};
// Owns the task-tracking rule, so its new template text waits in the staging folder.
const ownRule = (r) => r.write(".bindwright/owned", `${RULE}\n`);
// Appends `line` to the testing rule's copy in the repo, so the copy differs from its base.
const editTesting = (line) => (r) => r.write(OTHER, `${r.read(OTHER)}${line}\n`);
// Runs one row's change and checks one report key. `updated` defaults to the task-tracking rule.
async function checkRow(row) {
  const { out } = await update(row.repo ?? (() => {}), { edits: row.kit });
  assert.deepEqual(out.updated, row.updated ?? [RULE]);
  assert.deepEqual(out[row.key ?? "missing"], row.expect);
}

const namedRow = (row) => ({
  kit: { [RULE]: addLine(row.line) },
  repo: (r) => {
    drop(r, ...(row.gone ?? []));
    if (row.base !== undefined) withBase(row.base)(r);
  },
  expect: row.missing,
});
for (const row of NAMED_ROWS) {
  test(`named paths: ${row.name}`, needsPython, () => checkRow(namedRow(row)));
}

// Each row adds a line naming a section of the testing rule to the task-tracking template.
const SECTION_LINE = `See \`${OTHER}\` § Testing.`;
const SECTION_ROWS = [
  {
    name: "a section the repo's owned copy lacks is reported",
    kit: { [RULE]: addLine(SECTION_LINE) },
    repo: ownTesting,
    expect: [{ file: RULE, names: [`${OTHER} § Testing`] }],
  },
  {
    name: "a section the repo's copy has is not reported",
    kit: { [RULE]: addLine(SECTION_LINE) },
    expect: [],
  },
  {
    name: "section text matching no template heading is not reported",
    kit: { [RULE]: addLine(`See \`${OTHER}\` § Nothing here.`) },
    repo: ownTesting,
    expect: [],
  },
  {
    name: "a heading ending in a character that is not a space or tab keeps it, in both engines",
    kit: { [RULE]: addLine(SECTION_LINE) },
    repo: (r) => {
      r.write(".bindwright/owned", `${OTHER}\n`);
      r.write(OTHER, "# Testing﻿\n");
    },
    expect: [{ file: RULE, names: [`${OTHER} § Testing`] }],
  },
  {
    name: "a letter outside the BMP after the heading continues the word, in both engines",
    kit: { [RULE]: addLine(`See \`${OTHER}\` § Testing\u{1D400}.`) },
    repo: ownTesting,
    expect: [],
  },
  {
    name: "a section ref the base text already holds is not reported",
    kit: { [RULE]: addLine(`New \`${OTHER}\` § Testing.`) },
    repo: (r) => {
      ownTesting(r);
      withBase(`Old \`${OTHER}\` § Testing.`)(r);
    },
    expect: [],
  },
];
for (const row of SECTION_ROWS) {
  test(`section names: ${row.name}`, needsPython, () => checkRow(row));
}

// An added doc that the task-tracking template points at, so its pointer can land in a file.
const NEW_DOC = "docs/new-guide.md";
const POINTER_KIT = { [NEW_DOC]: "# New guide\n", [RULE]: addLine(`See \`${NEW_DOC}\`.`) };
const UNLINKED_ROWS = [
  {
    name: "an added file whose pointer lands in an owned file is listed",
    kit: POINTER_KIT,
    repo: ownRule,
    expect: [{ file: NEW_DOC, from: [RULE] }],
    updated: [],
  },
  {
    name: "the same file not owned, so updated, gives no entry",
    kit: POINTER_KIT,
    expect: [],
  },
  {
    name: "an owned file holding bytes that are not UTF-8 is read like any other",
    kit: POINTER_KIT,
    repo: (r) => {
      ownRule(r);
      writeFileSync(r.at(RULE), Buffer.from("# Caf\xe9\n", "latin1"));
    },
    expect: [{ file: NEW_DOC, from: [RULE] }],
    updated: [],
  },
];
for (const row of UNLINKED_ROWS) {
  test(`unlinked: ${row.name}`, needsPython, () => checkRow({ ...row, key: "unlinked" }));
}

// Each row drops templates from the kit, then edits the testing rule's copy in the repo.
const STALE_SECTION = `See \`${RULE}\` § Task tracking.`;
// A row whose target keeps its heading in today's template, while the repo's copy lacks it.
const keptHeading = (name, target) => ({
  name,
  kit: { [OTHER]: null },
  repo: (r) => {
    editTesting(STALE_SECTION)(r);
    target(r);
  },
  expect: [],
  updated: [],
});
const STALE_ROWS = [
  {
    name: "a kept edited file naming a section the update dropped is reported",
    kit: { [OTHER]: null, [RULE]: (text) => text.replace("# Task tracking", "# Work queue") },
    repo: editTesting(STALE_SECTION),
    expect: [{ file: OTHER, names: [`${RULE} § Task tracking`] }],
  },
  keptHeading("a section an owned target lacks, but its template keeps, gives no entry", (r) => {
    ownRule(r);
    r.write(RULE, "# Other\n");
  }),
  keptHeading("a section the repo edited out of an unchanged template gives no entry", (r) =>
    r.write(RULE, r.read(RULE).replace("# Task tracking", "# Work queue"))),
  keptHeading("a section of a target the repo deleted earlier gives no entry", (r) => drop(r, RULE)),
  {
    name: "a kept edited file naming a removed file is reported",
    kit: { [OTHER]: null, [THIRD]: null },
    repo: editTesting(`See \`${THIRD}\`.`),
    expect: [{ file: OTHER, names: [THIRD] }],
    updated: [],
  },
  {
    name: "a kept edited file naming only what still exists gives no entry",
    kit: { [OTHER]: null },
    repo: editTesting("See `.claude/settings.json`."),
    expect: [],
    updated: [],
  },
];
for (const row of STALE_ROWS) {
  test(`stale: ${row.name}`, needsPython, () => checkRow({ ...row, key: "stale" }));
}

const SKILL = ".claude/skills/close-session/SKILL.md";
const OLD_SKILL = ".claude/skills/session-close/SKILL.md";

// Only the old path's base names the dropped guide, so priors taken from the new path report it.
test("named paths: a moved file is compared with its base under the old path", needsPython, async () => {
  const { out } = await update((r) => {
    drop(r, GUIDE);
    const base = `${r.read(SKILL)}\nOld \`${GUIDE}\` wording.\n`;
    delete r.pristine.files[SKILL];
    r.pristine.files[OLD_SKILL] = base;
    rmSync(r.at(SKILL));
    r.write(OLD_SKILL, base);
  }, { edits: { [SKILL]: (text) => `${text}\nNew \`${GUIDE}\` wording.\n` } });
  assert.deepEqual(out.renamed, [[OLD_SKILL, SKILL]]);
  assert.deepEqual(out.updated, [SKILL]);
  assert.deepEqual(out.missing, []);
});

const REVIEW_GUIDE = ".github/review-guide.md";

// Only the rules-folder candidate resolves `testing.md` named from the review guide: neither
// `testing.md` nor `.github/testing.md` ships.
test("named paths: a bare rule name the repo left out is reported from elsewhere", needsPython, async () => {
  const { out } = await update((r) => {
    const named = r.read(REVIEW_GUIDE);
    const base = named.split("\n").filter((l) => !l.includes("`testing.md`")).join("\n");
    assert.notEqual(base, named, "the review guide names the testing rule by its bare name");
    r.pristine.files[REVIEW_GUIDE] = base;
    r.write(REVIEW_GUIDE, base);
    drop(r, OTHER);
  });
  assert.ok(out.updated.includes(REVIEW_GUIDE));
  assert.deepEqual(out.missing, [{ file: REVIEW_GUIDE, names: ["testing.md"] }]);
});

// Only the beside-the-file candidate resolves `review-gate.yml` named from the review guide.
test("named paths: a bare sibling the repo left out is reported", needsPython, async () => {
  const { out } = await update((r) => drop(r, ".github/review-gate.yml"), {
    edits: { [`${REVIEW_GUIDE}.template`]: (text) => `${text}\nSee \`review-gate.yml\`.\n` },
  });
  assert.deepEqual(out.updated, [REVIEW_GUIDE]);
  assert.deepEqual(out.missing, [{ file: REVIEW_GUIDE, names: ["review-gate.yml"] }]);
});

test("named paths: a merged file reports only what the template added", needsPython, async () => {
  const { out } = await update((r) => {
    drop(r, GUIDE, AUDIT);
    r.write(RULE, `Our own \`${GUIDE}\`.\n${r.read(RULE)}`);
  }, { edits: { [RULE]: (text) => `${text}\nSee \`${AUDIT}\`.\n` } });
  assert.deepEqual(out.merged, [RULE]);
  assert.deepEqual(out.missing, [{ file: RULE, names: [AUDIT] }]);
});

test("named paths: a held base is what a name is compared with", needsPython, async () => {
  const line = `See \`${GUIDE}\`.`;
  const { out } = await update((r) => {
    drop(r, GUIDE);
    const held = r.read(RULE);
    r.pristine.held = { [RULE]: held };
    r.pristine.files[RULE] = `${held}\nOld ${line}\n`;
  }, { edits: { [RULE]: (text) => `${text}\n${line}\n` } });
  assert.deepEqual(out.updated, [RULE]);
  assert.deepEqual(out.missing, [{ file: RULE, names: [GUIDE] }]);
});

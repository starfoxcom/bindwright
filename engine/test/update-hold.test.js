// /bindwright:update with --keep-base: a file held back for a later PR keeps its old base,
// so the next update offers its change again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PRISTINE, makeRepo } from "./bound-repo.js";
import { python } from "./python.js";
import { RULE, OTHER, LICENSE, needsPython, engines, older } from "./update-run.js";

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
    holdBack(at(2026)); // a repeat keeps the same base
    assert.equal(JSON.parse(repo.read(PRISTINE)).files[LICENSE], at(2026), `${cmd}: the base the update used`);
    const out = run(["--update", repo.at("")]);
    assert.ok(out.updated.includes(LICENSE), `${cmd}: ${JSON.stringify(out)}`);
    outs.push(out);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
  if (outs.length === 2) assert.deepEqual(outs[1], outs[0], "the two engines report alike");
});

test("a hold run before the file is restored puts back the record's base", needsPython, async () => {
  for (const [cmd, args] of python ? engines : engines.slice(0, 1)) {
    const run = (flags, input) => JSON.parse(spawnSync(cmd, [...args, ...flags], { encoding: "utf8", input }).stdout);
    let old;
    const repo = await makeRepo((r) => {
      old = r.read(LICENSE).replaceAll("2026", "2025");
      r.pristine.files[LICENSE] = old;
      r.write(LICENSE, old);
    });
    const hold = () => run(["--keep-base", repo.at("")], JSON.stringify({ paths: [LICENSE] }));
    run(["--update", repo.at("")]);
    hold();
    repo.write(LICENSE, old); // restored, and the later PR has not shipped yet
    run(["--update", repo.at("")]);
    hold(); // the repo still holds the text the update wrote, which equals the held text
    assert.equal(JSON.parse(repo.read(PRISTINE)).files[LICENSE], old, cmd);
    rmSync(repo.at(""), { recursive: true, force: true });
  }
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

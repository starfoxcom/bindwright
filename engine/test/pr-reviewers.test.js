// The reviewers asked on each PR: a list adds the Required reviewers section to
// git.md, null leaves it out, and bad lists are refused, in both engines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "../model.js";
import { withoutGithub } from "./code-host.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(engine, "..");
const noPython = !python && "needs Python 3.8+";

// Binds the answers through both commands, each reading them from stdin.
function bindBoth(answers) {
  const input = JSON.stringify(answers);
  return [
    spawnSync(process.execPath, [join(engine, "cli.js")], { cwd: repo, encoding: "utf8", input }),
    spawnSync(python, [join(engine, "bind.py")], { cwd: repo, encoding: "utf8", input }),
  ];
}

const gitRules = (stdout) => new Map(JSON.parse(stdout).files).get(".claude/rules/git.md");

function answersWith(reviewers, base = defaults({ team: true })) {
  base.advanced.prReviewers = reviewers;
  return base;
}

test("a list of reviewers adds the Required reviewers section to git.md", { skip: noPython }, () => {
  const answers = { team: true, client: false, advanced: { prReviewers: ["octo", "acme/web"] } };
  const [js, py] = bindBoth(answers);
  assert.equal(js.status, 0, js.stderr);
  assert.equal(py.stdout, js.stdout);
  assert.match(gitRules(js.stdout), /^### Required reviewers$/m);
});

test("null reviewers leave the section out of git.md", { skip: noPython }, () => {
  const [js, py] = bindBoth({ team: true, client: false, advanced: { prReviewers: null } });
  assert.equal(js.status, 0, js.stderr);
  assert.equal(py.stdout, js.stdout);
  assert.doesNotMatch(gitRules(js.stdout), /Required reviewers/);
});

const NAMES_MESSAGE = 'prReviewers must be null or 1-10 GitHub names ("user" or "org/team")';
const REFUSALS = [
  ["an 11-name list", answersWith(Array.from({ length: 11 }, (_, i) => `user${i}`)), NAMES_MESSAGE],
  ["a name with a space", answersWith(["octo cat"]), NAMES_MESSAGE],
  ["a repeated name", answersWith(["octo", "octo"]), NAMES_MESSAGE],
  ["codeHost local", withoutGithub(answersWith(["octo"], defaults({ team: false })), "local"),
    'prReviewers is for codeHost "github"'],
];

for (const [name, answers, message] of REFUSALS) {
  test(`refuses ${name} in both engines`, { skip: noPython }, () => {
    const [js, py] = bindBoth(answers);
    assert.equal(js.status, 1, name);
    assert.equal(py.status, 1, name);
    assert.equal(py.stdout, js.stdout, name);
    assert.equal(JSON.parse(js.stdout).error, `Invalid answers: ${message}`, name);
  });
}

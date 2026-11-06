// What a project off GitHub is told: a local project's files carry no step
// that needs a code host, and no project off GitHub points at a file the
// bind left out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bind } from "../bind.js";
import { defaults } from "../model.js";
import { withoutActions, withoutGithub } from "./code-host.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readFile = async (p) => readFileSync(join(repo, p), "utf8");
const coreFiles = JSON.parse(readFileSync(join(repo, "engine", "core-files.json"), "utf8"));

// Every switch that adds a rule on, so each optional file is read.
async function render(codeHost) {
  const a = withoutGithub(defaults({ client: true, isPrivate: true }), codeHost);
  Object.assign(a.advanced, { uiRule: true, confidentiality: true, cleanRoom: true, plainWriting: true });
  const files = await bind(a, { readFile, coreFiles, year: 2026 });
  return [...files].filter(([path]) => path.endsWith(".md") && !path.startsWith(".bindwright/global/"));
}

// A line that names a pull request or CI as a thing a project may have,
// not as a step to take.
const PASSING_MENTIONS = [
  "issue or PR numbers", "PR titles, PR bodies", "an issue, PR, commit message", "design doc or PR description",
  "issue/PR numbers", "docs or CI changes", "`chore` (build, CI, tooling, deps)", "CI secrets",
  "commit messages and PR descriptions", "there is no pull request",
];
const HOST_STEP = /\bPRs?\b|pull request|\bgh (pr|run|issue|api|repo)\b|origin\/|git (push|fetch)|\bCI\b/;
const LEFT_OUT = new RegExp([
  "PULL_REQUEST_TEMPLATE", "ISSUE_TEMPLATE", "CODEOWNERS",
  "review-tiers\\.md", "tracker\\.md", "review-gate\\.yml", "review-guide\\.md",
].join("|"));

function offending(files, pattern) {
  const found = [];
  for (const [path, text] of files) {
    text.split("\n").forEach((line, i) => {
      const passing = PASSING_MENTIONS.some((ok) => line.includes(ok));
      if (pattern.test(line) && !passing) found.push(`${path}:${i + 1}: ${line}`);
    });
  }
  return found;
}

test("a local project's files name no pull request, CI or remote step", async () => {
  assert.deepEqual(offending(await render("local"), HOST_STEP), []);
});

test("GitHub with apps, Actions and boards blocked: no workflow, gate or board, and PRs stay", async () => {
  const a = withoutActions(defaults({ team: true, client: true, isPrivate: true }));
  Object.assign(a.advanced, { uiRule: true, confidentiality: true, cleanRoom: true, plainWriting: true });
  const files = await bind(a, { readFile, coreFiles, year: 2026 });
  const paths = [...files.keys()];
  const actionsFiles = /^\.github\/(workflows\/|review-|scripts\/(review_gate|setup-review-gate|pin_check))/;
  assert.deepEqual(paths.filter((path) => actionsFiles.test(path)), []);
  assert.ok(paths.includes(".claude/rules/code-host.md") && paths.includes(".github/scripts/size_check.py"));
  const rules = [...files].filter(([path]) => path.endsWith(".md") && !path.startsWith(".bindwright/global/")
    && path !== ".claude/rules/code-host.md");
  // A line may say no CI runs here; it may not count on one.
  const ciStep = /\bCI\b|gh pr checks|gh run\b|review-tiers\.md|review-gate|AI review|routine review|deep review/i;
  assert.deepEqual(offending(rules, ciStep).filter((line) => !/\bno CI\b/i.test(line)), []);
  assert.match(files.get(".claude/rules/git.md"), /^## Pull requests$/m);
});

test("a team project without AI review is never told an AI verdict gates its merge", async () => {
  const github = defaults({ team: true });
  Object.assign(github.advanced, { aiReview: false, deepEscalation: false });
  const binds = [github, withoutGithub(defaults({ team: true }), "other"), withoutActions(defaults({ team: true }))];
  const aiVerdict = /🔴|🟢|AI review|routine review|deep review/i;
  for (const answers of binds) {
    const files = await bind(answers, { readFile, coreFiles, year: 2026 });
    const rules = [...files].filter(([path]) => /(^|\/)(CONTRIBUTING\.md|collaboration\.md)$/.test(path));
    assert.equal(rules.length, 2, answers.advanced.codeHost);
    assert.deepEqual(offending(rules, aiVerdict), [], answers.advanced.codeHost);
  }
});

test("no project off GitHub points at a GitHub file the bind left out", async () => {
  for (const host of ["local", "other"]) {
    // The note for other hosts names those files on purpose: it says what was left out.
    const files = (await render(host)).filter(([path]) => path !== ".claude/rules/code-host.md");
    assert.deepEqual(offending(files, LEFT_OUT), [], host);
  }
});

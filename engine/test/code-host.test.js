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
import { withoutGithub } from "./code-host.js";

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
const LEFT_OUT = /PULL_REQUEST_TEMPLATE|ISSUE_TEMPLATE|CODEOWNERS|review-tiers\.md|tracker\.md|review-gate\.yml|review-guide\.md/;

function offending(files, pattern) {
  const found = [];
  for (const [path, text] of files) {
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line) && !PASSING_MENTIONS.some((ok) => line.includes(ok))) found.push(`${path}:${i + 1}: ${line}`);
    });
  }
  return found;
}

test("a local project's files name no pull request, CI or remote step", async () => {
  assert.deepEqual(offending(await render("local"), HOST_STEP), []);
});

test("no project off GitHub points at a GitHub file the bind left out", async () => {
  for (const host of ["local", "other"]) {
    // The note for other hosts names those files on purpose: it says what was left out.
    const files = (await render(host)).filter(([path]) => path !== ".claude/rules/code-host.md");
    assert.deepEqual(offending(files, LEFT_OUT), [], host);
  }
});

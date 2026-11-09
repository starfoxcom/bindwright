// The local review answer: it writes .claude/rules/local-review.md, the rule keeps
// everything about the review off the host, and the answers it cannot run on are refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, expandAnswers } from "../model.js";
import { withoutActions, withoutGithub } from "./code-host.js";
import { bindResult, clone, firstDifference, pythonBind } from "./both-engines.js";
import { python } from "./python.js";

const RULE = ".claude/rules/local-review.md";
const CODE_HOST_RULE = ".claude/rules/code-host.md";

// A setup code's answers: the GitHub organization blocks apps and Actions, so no CI runs the AI reviews.
const LOCAL_REVIEW_ANSWERS = expandAnswers({
  team: false, client: true, private: true,
  advanced: { githubApps: false, aiReview: false, deepEscalation: false, localReview: true },
});

const withLocalReview = (localReview) => {
  const answers = clone(LOCAL_REVIEW_ANSWERS);
  answers.advanced.localReview = localReview;
  return answers;
};

const withLocalReviewOn = (answers) => {
  answers.advanced.localReview = true;
  return answers;
};

// The rendered files of a bind that must succeed, keyed by path.
async function boundFiles(answers) {
  const result = await bindResult(answers);
  assert.equal(result.error, undefined, result.error);
  return new Map(result.files);
}

test("local review on: the rule is written, and code-host.md points at it", async () => {
  const files = await boundFiles(withLocalReview(true));
  assert.ok(files.has(RULE));
  const codeHost = files.get(CODE_HOST_RULE);
  assert.match(codeHost, /local-review\.md/);
  assert.doesNotMatch(codeHost, /a local review the user asks for/);
});

test("local review off: no rule file, and code-host.md keeps the review the user asks for", async () => {
  const files = await boundFiles(withLocalReview(false));
  assert.equal(files.has(RULE), false);
  assert.match(files.get(CODE_HOST_RULE), /a local review the user asks for/);
});

// Commands that would post the review, label it, or write a status to the host.
const HOST_COMMANDS = [
  ["a pull request comment", /gh pr comment\b/i],
  ["a pull request review", /gh pr review\b/i],
  ["an issue comment", /gh issue comment\b/i],
  ["an API call", /\bgh api\b/i],
  ["a label", /--add-label\b/i],
  ["a pull request edit", /gh pr edit\b/i],
  ["a check listing", /gh pr checks\b/i],
  ["a commit status", /\bstatuses\b/i],
];

test("the local review rule keeps every part of the review off the host", async () => {
  const text = (await boundFiles(withLocalReview(true))).get(RULE);
  const reached = HOST_COMMANDS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  assert.deepEqual(reached, []);
});

// Named answers. Each row either binds (refusal is null) or is refused with exactly that message.
const refusedWith = (msg) => `Invalid answers: ${msg}`;
const NEEDS_NO_CI_REVIEW = "localReview is for projects without CI reviews: aiReview must be false";
const NEEDS_HOST = 'localReview needs codeHost "other", or "github" with githubApps false';
const LOCAL_REVIEW_ROWS = [
  ["the setup answers with local review bind", withLocalReview(true), null],
  ["the setup answers without local review bind", withLocalReview(false), null],
  ["local review on another host is accepted", withLocalReviewOn(withoutGithub(defaults(), "other")), null],
  ["local review with GitHub apps blocked is accepted", withLocalReviewOn(withoutActions(defaults())), null],
  ["local review with AI review on is refused", withLocalReviewOn(defaults()), refusedWith(NEEDS_NO_CI_REVIEW)],
  ["local review on a local computer is refused", withLocalReviewOn(withoutGithub(defaults(), "local")),
    refusedWith(NEEDS_HOST)],
  ["local review on GitHub with apps on is refused", withLocalReviewOn(githubWithAppsAndNoAiReview()),
    refusedWith(NEEDS_HOST)],
];

// GitHub with apps on and no AI review: the host, not the review, is what is refused.
function githubWithAppsAndNoAiReview() {
  const answers = defaults();
  answers.advanced.aiReview = false;
  answers.advanced.deepEscalation = false;
  return answers;
}

const BOTH_ENGINES = "local review answers: both engines accept or refuse each named row the same way";
test(BOTH_ENGINES, { skip: !python && "needs Python 3.8+" }, async () => {
  const results = pythonBind(LOCAL_REVIEW_ROWS.map(([, answers]) => answers));
  for (const [i, [name, answers, refusal]] of LOCAL_REVIEW_ROWS.entries()) {
    const js = await bindResult(answers);
    assert.equal(js.error ?? null, refusal, `${name} (js)`);
    assert.equal(results[i].error ?? null, refusal, `${name} (py)`);
    if (refusal === null) assert.equal(firstDifference(js.files, results[i].files), null, name);
  }
});

// The setup's files as a few plain groups, for people who will never open
// them: what each group does for the project, not what the files are called.

import { flagsFor } from "../engine/model.js";

const GROUPS = [
  {
    id: "rules", title: "Rules Claude follows", match: /^\.claude\/rules\//,
    say: "Claude reads these at the start of every session, so it works your way without being told again.",
  },
  {
    id: "reviews", title: "Pull request reviews",
    match: new RegExp("^\\.github/(workflows/(claude|pin-check)|review-|CODEOWNERS|PULL_REQUEST"
      + "|scripts/(review_gate|setup-review-gate|pin_check))"),
    say: "An AI reviews every pull request, and nothing merges until the review passes.",
  },
  {
    id: "guards", title: "Safety guards", match: /^\.claude\/(hooks\/|settings)/,
    say: "Risky commands, like a force push to your main branch, are stopped before they run.",
  },
  {
    id: "sessions", title: "Session routines", match: /^(\.claude\/skills\/|\.bindwright\/session-steps)/,
    say: "/session-start plans the work with you. /session-close checks what is really done "
      + "and leaves a note for next time.",
  },
  {
    id: "checks", title: "Code checks",
    match: /^(lefthook\.yml|\.husky\/|\.pre-commit|\.github\/(workflows\/size-check|scripts\/size_check|size-check\/))/,
    say: "Checks that run before each commit or on every pull request.",
  },
  {
    id: "issues", title: "Issue forms", match: /^\.github\/ISSUE_TEMPLATE\//,
    say: "Ready-made forms for bug reports, feature requests and planned work.",
  },
  {
    id: "project", title: "Project files",
    match: /^(CLAUDE\.md|README|LICENSE|CHANGELOG|CONTRIBUTING|\.gitattributes|docs\/)/,
    say: "The main file Claude reads about your project, plus a readme and changelog. "
      + "Setup merges them with yours.",
  },
  { id: "notes", title: "Bindwright's notes", match: /^\.bindwright\//,
    say: "Your answers, so a later update keeps your own edits." },
];

// One plain line per rule file, by name.
const RULES = {
  "architecture": ["Your code structure", "New code goes into the layers of the structure you picked."],
  "clean-code": ["Code a newcomer reads", "Clear names, short comments, no copies of the same code."],
  "clean-room": ["Clean room", "Code inspired by another product never copies it."],
  "code-size": ["Small, readable code", "Functions and files stay short enough to follow."],
  "collaboration": ["Working together", "How teammates share branches and answer reviews."],
  "confidentiality": ["Client secrets", "Client secrets stay out of Claude's memory."],
  "git": ["Clean history", "Clear commit messages and one branch per change."],
  "review-tiers": ["How reviews work", "What the AI reviewer checks, and when it looks deeper."],
  "security": ["No secrets ship", "Keys and passwords stay out of the code and everything you release."],
  "shipped-text": ["Plain writing", "Text people read sounds like a person wrote it."],
  "task-tracking": ["A visible to-do list", "Claude keeps a task list on any job with several steps."],
  "testing": ["Real tests", "Tests check the real code, edge cases included."],
  "token-efficiency": ["Less wasted usage", "Claude looks code up before reading whole files."],
  "tracker": ["Work tracking", "Work is written down between sessions, so nothing gets lost."],
  "visual": ["Screen changes in small steps", "Anything people see is built in pieces you check by eye."],
};

// Each license as a visitor reads it.
const LICENSE_WORDS = {
  MIT: "MIT, free for anyone to reuse",
  "Apache-2.0": "Apache 2.0, free for anyone to reuse",
  "BSD-3-Clause": "BSD, free for anyone to reuse",
  Proprietary: "all rights reserved",
};

// Answer-driven detail lines on a card. `id` names the line's slot, so a pair
// of lines for on and off shares one id and a changed text reads as Changed.
// `show` gets the engine's flags, the answers and has(path), which says whether
// a file is in the setup. `text` is a string or a function of the answers.
const FACTS = [
  {
    id: "license", group: "project", text: (a) => `License: ${LICENSE_WORDS[a.project.license]}`,
    show: (f, a, has) => has("LICENSE"),
  },
  {
    id: "contributing", group: "project", text: "A contributing guide for teammates",
    show: (f, a, has) => has("CONTRIBUTING.md"),
  },
  {
    id: "deep-review", group: "reviews",
    text: "Risky changes get a deeper second review on their own",
    show: (f) => f.github_actions_deep_review_auto_fire,
  },
  {
    id: "deep-review", group: "reviews",
    text: "A deeper second review runs when someone asks for one",
    show: (f) => f.github_actions_deep_review && !f.github_actions_deep_review_auto_fire,
  },
  {
    id: "docs-merge", group: "reviews",
    text: "Changes to docs only merge without waiting for a review",
    show: (f) => f.github_actions_paths_ignore_auto_merge,
  },
  {
    id: "docs-merge", group: "reviews",
    text: "Every change waits for its review, docs included",
    show: (f) => f.github_actions_routine_review && !f.github_actions_paths_ignore_auto_merge,
  },
  {
    id: "pr-form", group: "reviews",
    text: "A pull request form that asks what changed and why",
    show: (f, a, has) => has(".github/PULL_REQUEST_TEMPLATE.md"),
  },
  {
    id: "codeowners", group: "reviews", text: "Reviewers picked by folder",
    show: (f, a, has) => has(".github/CODEOWNERS"),
  },
  {
    id: "precommit", group: "checks", text: "Checks run before every commit",
    show: (f) => f.precommit_hooks_scaffold,
  },
  {
    id: "audit-trail", group: "rules", text: "Commits record which work had AI help",
    show: (f) => f.audit_trail_commits,
  },
];

const indexById = (list) => new Map(list.map((g) => [g.id, g]));
const factIndex = (cards) => new Map(cards.flatMap((g) => g.facts).map((fact) => [fact.id, fact]));
const ruleNames = (index) => new Set((index.get("rules")?.rules ?? []).map(([name]) => name));
// A card's content as text: a card whose files, rules or lines differ has changed.
const signature = (group) => JSON.stringify([group.files, group.rules ?? null, group.facts]);

// What changed from `before` to `after`. Cards and rules are told apart by name,
// facts by id. A fact whose id stays but whose text differs is changed, not removed.
export function compare(before, after) {
  const [was, now] = [indexById(before), indexById(after)];
  const [hadRules, hasRules] = [ruleNames(was), ruleNames(now)];
  const [hadFacts, hasFacts] = [factIndex(before), factIndex(after)];
  const kept = [...now.keys()].filter((id) => was.has(id));
  return {
    addedGroups: new Set([...now.keys()].filter((id) => !was.has(id))),
    removedGroups: before.filter((g) => !now.has(g.id)),
    changedGroups: new Set(kept.filter((id) => signature(was.get(id)) !== signature(now.get(id)))),
    addedRules: new Set([...hasRules].filter((name) => !hadRules.has(name))),
    removedRules: [...hadRules].filter((name) => !hasRules.has(name)),
    addedFacts: new Set([...hasFacts.keys()].filter((id) => !hadFacts.has(id))),
    changedFacts: new Set([...hasFacts.keys()].filter((id) => hadFacts.has(id)
      && hadFacts.get(id).text !== hasFacts.get(id).text)),
    removedFacts: [...hadFacts.values()]
      .filter((fact) => !hasFacts.has(fact.id) && now.has(fact.group)),
  };
}

// The facts the setup shows, as { id, group, text } in FACTS order.
function factsFor(files, answers) {
  const flags = flagsFor(answers);
  const paths = new Set(files.map(([path]) => path));
  const has = (path) => paths.has(path);
  return FACTS.filter((fact) => fact.show(flags, answers, has)).map((fact) => ({
    id: fact.id,
    group: fact.group,
    text: typeof fact.text === "function" ? fact.text(answers) : fact.text,
  }));
}

// [{ id, title, say, files, rules?, facts }] for the groups that have files, in GROUPS order.
export function summarize(files, answers) {
  const groups = GROUPS.map((g) => ({ ...g, files: [] }));
  const other = { id: "other", title: "Other files", say: "Supporting files the rest relies on.", files: [] };
  for (const [path] of files) (groups.find((g) => g.match.test(path)) ?? other).files.push(path);
  const rules = groups.find((g) => g.id === "rules");
  rules.rules = rules.files.map((p) => p.split("/").pop().replace(/\.md$/, ""))
    .map((name) => RULES[name] ?? [name, ""]);
  const facts = factsFor(files, answers);
  return [...groups, other].filter((g) => g.files.length)
    .map((g) => ({ ...g, facts: facts.filter((f) => f.group === g.id) }));
}

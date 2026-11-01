// The setup's files as a few plain groups, for people who will never open
// them: what each group does for the project, not what the files are called.

import { flagsFor } from "../engine/model.js";
import { t } from "./i18n/index.js";

const GROUPS = [
  {
    id: "rules", title: t("group.rules.title"), match: /^\.claude\/rules\//,
    say: t("group.rules.say"),
  },
  {
    id: "reviews", title: t("group.reviews.title"),
    match: new RegExp("^\\.github/(workflows/(claude|pin-check)|review-|CODEOWNERS|PULL_REQUEST"
      + "|scripts/(review_gate|setup-review-gate|pin_check))"),
    say: t("group.reviews.say"),
  },
  {
    id: "guards", title: t("group.guards.title"), match: /^\.claude\/(hooks\/|settings)/,
    say: t("group.guards.say"),
  },
  {
    id: "sessions", title: t("group.sessions.title"), match: /^(\.claude\/skills\/|\.bindwright\/session-steps)/,
    say: t("group.sessions.say"),
  },
  {
    id: "checks", title: t("group.checks.title"),
    match: /^(lefthook\.yml|\.husky\/|\.pre-commit|\.github\/(workflows\/size-check|scripts\/size_check|size-check\/))/,
    say: t("group.checks.say"),
  },
  {
    id: "issues", title: t("group.issues.title"), match: /^\.github\/ISSUE_TEMPLATE\//,
    say: t("group.issues.say"),
  },
  {
    id: "project", title: t("group.project.title"),
    match: /^(CLAUDE\.md|README|LICENSE|CHANGELOG|CONTRIBUTING|\.gitattributes|docs\/)/,
    say: t("group.project.say"),
  },
  {
    id: "notes", title: t("group.notes.title"), match: /^\.bindwright\//,
    say: t("group.notes.say"),
  },
];

// The rule files the page names in plain words, by file name.
const RULE_NAMES = [
  "architecture", "clean-code", "clean-room", "code-size", "collaboration", "confidentiality",
  "git", "review-tiers", "security", "shipped-text", "task-tracking", "testing",
  "token-efficiency", "tracker", "visual",
];

// One plain [name, line] pair per rule file, by name.
const RULES = Object.fromEntries(RULE_NAMES.map((name) => [
  name, [t(`rule.${name}.name`), t(`rule.${name}.line`)],
]));

// Each license as a visitor reads it, by license id.
const LICENSE_IDS = ["MIT", "Apache-2.0", "BSD-3-Clause", "Proprietary"];
const LICENSE_WORDS = Object.fromEntries(LICENSE_IDS.map((id) => [id, t(`license.${id}`)]));

// Answer-driven detail lines on a card, each keyed by `fact.${id}`. `show` gets the
// engine's flags, the answers and has(path), which says whether a file is in the
// setup. `values` gives the text's {placeholders} from the answers, when it has any.
const FACTS = [
  {
    id: "license", group: "project",
    show: (f, a, has) => has("LICENSE"),
    values: (a) => ({ words: LICENSE_WORDS[a.project.license] }),
  },
  {
    id: "contributing", group: "project",
    show: (f, a, has) => has("CONTRIBUTING.md"),
  },
  {
    id: "deep-auto", group: "reviews",
    show: (f) => f.github_actions_deep_review_auto_fire,
  },
  {
    id: "deep-asked", group: "reviews",
    show: (f) => f.github_actions_deep_review && !f.github_actions_deep_review_auto_fire,
  },
  {
    id: "docs-auto", group: "reviews",
    show: (f) => f.github_actions_paths_ignore_auto_merge,
  },
  {
    id: "review-all", group: "reviews",
    show: (f) => f.github_actions_routine_review && !f.github_actions_paths_ignore_auto_merge,
  },
  {
    id: "pr-form", group: "reviews",
    show: (f, a, has) => has(".github/PULL_REQUEST_TEMPLATE.md"),
  },
  {
    id: "owners", group: "reviews",
    show: (f, a, has) => has(".github/CODEOWNERS"),
  },
  {
    id: "precommit", group: "checks",
    show: (f) => f.precommit_hooks_scaffold,
  },
  {
    id: "ai-commits", group: "rules",
    show: (f) => f.audit_trail_commits,
  },
];

// The facts the setup shows, as { group, text } in FACTS order.
function factsFor(files, answers) {
  const flags = flagsFor(answers);
  const paths = new Set(files.map(([path]) => path));
  const has = (path) => paths.has(path);
  return FACTS.filter((fact) => fact.show(flags, answers, has)).map((fact) => ({
    group: fact.group,
    text: t(`fact.${fact.id}`, fact.values?.(answers)),
  }));
}

// [{ id, title, say, files, rules?, facts }] for the groups that have files, in GROUPS order.
export function summarize(files, answers) {
  const groups = GROUPS.map((g) => ({ ...g, files: [] }));
  const other = {
    id: "other", title: t("group.other.title"), say: t("group.other.say"), files: [],
  };
  for (const [path] of files) (groups.find((g) => g.match.test(path)) ?? other).files.push(path);
  const rules = groups.find((g) => g.id === "rules");
  rules.rules = rules.files.map((p) => p.split("/").pop().replace(/\.md$/, ""))
    .map((name) => RULES[name] ?? [name, ""]);
  const facts = factsFor(files, answers);
  return [...groups, other].filter((g) => g.files.length)
    .map((g) => ({ ...g, facts: facts.filter((f) => f.group === g.id) }));
}

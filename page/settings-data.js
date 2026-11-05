// The settings the All settings page lists, in three groups plus the mods.
// tools/page_settings.mjs renders them into page/settings/index.html, and
// engine/test/page-settings.test.js checks them against the engine.
//
// Each entry: id (kebab-case), title, text (what it changes, one short line), value (the
// default setup picks), keys (the engine answers it covers: "team", "project.name",
// "extra:<name>" for a file setup adds, "setting:<name>" for a computer setting the answers do
// not hold, and "mods" for the mods entry).
// An optional engine list holds { flags, key, value } checks against defaults(flags).
// An optional links map turns each named tool in the text into a link to its project.
// Plain text only: no "&" and no "<" in any string.

export const COMPUTER = [
  {
    id: "code-research",
    title: "Code search",
    text: "tokensave indexes your code so answers come about a quarter faster on big codebases, "
      + "for a few percent more tokens. none uses the built-in search: as accurate and cheaper, but slower.",
    value: "tokensave",
    keys: ["advanced.codeResearch", "advanced.codeResearchCustom"],
    options: ["tokensave", "none"],
    links: {
      tokensave: "https://github.com/aovestdipaperino/tokensave",
    },
  },
  {
    id: "work-language",
    title: "Work language",
    text: "The language replies, commit messages and code comments come in, English or Spanish. "
      + "The setup's own files stay in English: only the assistant reads them.",
    value: "English",
    keys: ["setting:language"],
  },
  {
    id: "global-instructions",
    title: "Global instructions",
    text: "Working rules every project on your computer reads.",
    value: "Yes",
    keys: ["extra:global-instructions"],
  },
  {
    id: "push-guard",
    title: "Push guard",
    text: "Blocks force pushes in every repo on your computer.",
    value: "Yes",
    keys: ["extra:push-guard"],
  },
  {
    id: "builder",
    title: "Builder agent",
    text: "A cheap Haiku helper writes the code, and the main model checks it.",
    value: "Yes",
    keys: ["extra:builder"],
  },
  {
    id: "code-style",
    title: "Code-style profile",
    text: "Learns how you write code from your repos, with your permission.",
    value: "Yes",
    keys: ["extra:code-style"],
  },
  {
    id: "reply-style",
    title: "Reply style",
    text: "Short, plain replies that are easy to follow (or at least it tries ;V): the answer first, " +
      "and a follow-up question when it needs one. /output-style default turns it off.",
    value: "Yes",
    keys: ["extra:reply-style"],
  },
  {
    id: "mods-group",
    title: "Mods",
    text: "Add-ons that show live status in Claude Code. They need CLI 2.1.287 or later and Node.",
    keys: ["mods"],
  },
];

export const PROJECT = [
  {
    id: "who-works",
    title: "Who works on it",
    text: "A team gets collaboration rules and a pre-commit hook.",
    value: "Just me",
    keys: ["team"],
  },
  {
    id: "whose-project",
    title: "Whose project",
    text: "A client's or employer's gets a proprietary license.",
    value: "Mine",
    keys: ["client"],
  },
  {
    id: "visibility",
    title: "Public or private",
    text: "Whether the code is open to everyone on GitHub.",
    value: "Public if it's yours",
    keys: ["private"],
  },
  {
    id: "ai-credit",
    title: "AI credit in commits",
    text: "No AI co-author or generated-with lines, and a guard blocks them.",
    value: "Kept out",
    keys: ["advanced.attributionGuard"],
    engine: [{ flags: {}, key: "advanced.attributionGuard", value: true }],
  },
  {
    id: "ai-review",
    title: "AI review",
    text: "An AI reviews every pull request before it merges.",
    value: "On",
    keys: ["advanced.aiReview"],
    engine: [{ flags: {}, key: "advanced.aiReview", value: true }],
  },
  {
    id: "deep-review",
    title: "Deep review",
    text: "Risky changes get a second, deeper review.",
    value: "On",
    keys: ["advanced.deepEscalation"],
    engine: [{ flags: {}, key: "advanced.deepEscalation", value: true }],
  },
  {
    id: "code-size",
    title: "Code-size check",
    text: "Fails when code grows past the size limits.",
    value: "On",
    keys: ["advanced.codeSizeCheck"],
    engine: [{ flags: {}, key: "advanced.codeSizeCheck", value: true }],
  },
  {
    id: "plain-writing",
    title: "Plain-language writing",
    text: "Plain words that try to sound like you (it's still an AI writing them ;V).",
    value: "On",
    keys: ["advanced.plainWriting"],
    engine: [{ flags: {}, key: "advanced.plainWriting", value: true }],
  },
  {
    id: "visual-steps",
    title: "Visual changes in small steps",
    text: "Anything people see changes one checked step at a time.",
    value: "On",
    keys: ["advanced.uiRule"],
    engine: [{ flags: {}, key: "advanced.uiRule", value: true }],
  },
  {
    id: "code-host",
    title: "Where the code lives",
    text: "GitHub, just this computer, or another site. Just this computer needs no account; "
      + "another site gets the GitHub parts to adapt.",
    value: "GitHub",
    keys: ["advanced.codeHost"],
  },
  {
    id: "work-state",
    title: "Where work is tracked",
    text: "A GitHub board, issues only, or a hand-off file in the repo.",
    value: "GitHub board",
    keys: ["advanced.tracker", "advanced.handoffFile", "advanced.trackerProject"],
  },
  {
    id: "work-items-repo",
    title: "Private repo for work items",
    text: "Asked for public code, since its issues are public too.",
    value: "Yes",
    keys: ["advanced.trackerRepo"],
  },
  {
    id: "board-visibility",
    title: "Board visibility",
    text: "The board holds every engineering detail. A clean public copy is optional.",
    value: "Private",
    keys: ["advanced.publicRoadmap"],
    engine: [{ flags: {}, key: "advanced.publicRoadmap", value: null }],
  },
];

export const FIXED = [
  {
    id: "name-and-repo",
    title: "Name, repo and license holder",
    text: "Read from the folder, its git remote and your git name.",
    value: "From the repo",
    keys: ["project.name", "project.repoUrl", "project.licenseHolder"],
  },
  {
    id: "license",
    title: "License",
    text: "MIT for your own public project, Proprietary otherwise.",
    value: "MIT or Proprietary",
    keys: ["project.license"],
    engine: [
      { flags: {}, key: "project.license", value: "MIT" },
      { flags: { client: true }, key: "project.license", value: "Proprietary" },
    ],
  },
  {
    id: "branching",
    title: "Branching",
    text: "main for releases, develop for work.",
    value: "Gitflow",
    keys: ["advanced.branching", "advanced.devIsDefault"],
    engine: [
      { flags: {}, key: "advanced.branching", value: "gitflow" },
      { flags: {}, key: "advanced.devIsDefault", value: false },
    ],
  },
  {
    id: "merge-style",
    title: "Merge style",
    text: "Each branch stays visible in the history.",
    value: "Merge commits",
    keys: ["advanced.mergeStyle"],
    engine: [{ flags: {}, key: "advanced.mergeStyle", value: "merge" }],
  },
  {
    id: "pre-commit",
    title: "Pre-commit hook",
    text: "A team gets lefthook, which runs checks before each commit.",
    value: "Team only",
    links: { lefthook: "https://github.com/evilmartians/lefthook" },
    keys: ["advanced.precommit"],
    engine: [
      { flags: {}, key: "advanced.precommit", value: "none" },
      { flags: { team: true }, key: "advanced.precommit", value: "lefthook" },
    ],
  },
  {
    id: "guard-location",
    title: "Where the guards live",
    text: "In the repo, so everyone who clones it gets them.",
    value: "In the repo",
    keys: ["advanced.hookLocation", "extra:attribution-guard"],
    engine: [{ flags: {}, key: "advanced.hookLocation", value: "repo" }],
  },
  {
    id: "blocked-commands",
    title: "Blocked commands",
    text: "Commands the assistant may never run.",
    value: "Standard",
    keys: ["advanced.denyProfile"],
    engine: [{ flags: {}, key: "advanced.denyProfile", value: "standard" }],
  },
  {
    id: "architecture",
    title: "Architecture rule",
    text: "A folder layout to follow: clean, ddd, ecs, feature-based, hexagonal, layered or mvc.",
    value: "None",
    keys: ["advanced.architecture"],
    engine: [{ flags: {}, key: "advanced.architecture", value: "none" }],
  },
  {
    id: "confidentiality",
    title: "Confidentiality rule",
    text: "Added for someone else's private project.",
    value: "Client work only",
    keys: ["advanced.confidentiality"],
    engine: [
      { flags: { client: true }, key: "advanced.confidentiality", value: true },
      { flags: {}, key: "advanced.confidentiality", value: false },
    ],
  },
  {
    id: "clean-room",
    title: "Clean-room rule",
    text: "Keeps copied material out of a project based on an existing work.",
    value: "Off",
    keys: ["advanced.cleanRoom"],
    engine: [{ flags: {}, key: "advanced.cleanRoom", value: false }],
  },
  {
    id: "shipped-text",
    title: "Files the writing rule checks",
    text: "Which files the plain-language rule checks.",
    value: "The rule's list",
    keys: ["advanced.shippedTextPaths"],
    engine: [{ flags: {}, key: "advanced.shippedTextPaths", value: null }],
  },
];

// One row per mod in the engine's MODS list, in the same order. The title is the mod's name.
export const MODS_ROWS = [
  { id: "ci-watch", text: "Watches pull request checks and wakes the session when they finish.", value: "On" },
  { id: "compact-handoff", text: "Carries your words and a hand-off across compactions.", value: "On" },
  { id: "mods", text: "A pane listing your mods and their commands.", value: "On" },
  { id: "runners", text: "Shows your local CI runners, with start and stop buttons.", value: "Off" },
  { id: "session-facts", text: "Tells the assistant the time, its context fill and your plan usage.", value: "On" },
  { id: "session-info", text: "A row with the model, project, branch and changed files.", value: "On" },
  { id: "shared-pc", text: "One session at a time runs heavy work, the rest wait in line.", value: "Off" },
  { id: "skill-check", text: "Checks a skill ran every step it requires.", value: "On" },
  { id: "tasks", text: "Keeps the task list honest and carries it across compactions.", value: "On" },
  { id: "usage-guard", text: "Saves work near a plan limit and resumes after it resets.", value: "On" },
];

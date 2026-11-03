// The settings the All settings page lists, in three groups plus the mods.
// tools/page_settings.mjs renders them into page/settings/index.html, and
// engine/test/page-settings.test.js checks them against the engine.
//
// Each entry: id (kebab-case), title, text (what it changes), value (the default
// or recommended answer), keys (the engine answers it covers: "team", "project.name",
// "extra:<name>" for a file setup adds, and "mods" for the mods entry).
// An optional engine list holds { flags, key, value } checks against defaults(flags).
// Plain text only: no "&" and no "<" in any string.

export const COMPUTER = [
  {
    id: "code-research",
    title: "Code-search tool",
    text: "How the assistant finds code in your projects. Setup installs the one you pick and "
      + "indexes each project. Choices: tokensave, lsp-plugins, codegraph, serena, codebase-memory or none.",
    value: "tokensave (recommended)",
    keys: ["advanced.codeResearch", "advanced.codeResearchCustom"],
    options: ["tokensave", "lsp-plugins", "codegraph", "serena", "codebase-memory", "none"],
  },
  {
    id: "global-instructions",
    title: "Global instructions",
    text: "A short set of working rules every project on your computer reads, added to "
      + "~/.claude/CLAUDE.md.",
    value: "Yes (recommended)",
    keys: ["extra:global-instructions"],
  },
  {
    id: "push-guard",
    title: "Push guard for every project",
    text: "Blocks force pushes in every repo on your computer, including ones Bindwright never set up.",
    value: "Yes (recommended)",
    keys: ["extra:push-guard"],
  },
  {
    id: "builder",
    title: "Builder agent",
    text: "A helper on the small, cheap Haiku model writes the code for a short brief, while the main "
      + "model plans, runs the tests, reads the diff and commits. It costs a fraction of the main model "
      + "doing the same work. Choosing no keeps all the work in the main session.",
    value: "Yes (recommended)",
    keys: ["extra:builder"],
  },
  {
    id: "code-style",
    title: "Code-style profile",
    text: "With your permission, reads code you wrote by hand, in local repos and your GitHub account, "
      + "and saves a short profile of how you write. The weak spots are brought up to current practice, "
      + "and every session follows it.",
    value: "Yes (recommended), now or later",
    keys: ["extra:code-style"],
  },
  {
    id: "mods-group",
    title: "Mods",
    text: "Small add-ons for Claude Code that show live status and add commands. They need CLI 2.1.287 "
      + "or later and Node, and you pick which ones to add.",
    keys: ["mods"],
  },
];

export const PROJECT = [
  {
    id: "who-works",
    title: "Who works on it",
    text: "Just you, or a team. A team gets the collaboration rules and a pre-commit hook.",
    value: "Just me",
    keys: ["team"],
  },
  {
    id: "whose-project",
    title: "Whose project it is",
    text: "Yours, or someone else's, such as a client's or an employer's. Someone else's gets a "
      + "proprietary license and, when private, a confidentiality rule.",
    value: "Mine",
    keys: ["client"],
  },
  {
    id: "visibility",
    title: "Private or public",
    text: "Whether the code is open to everyone on GitHub or kept private to you and your team.",
    value: "Public for your own project, private for someone else's",
    keys: ["private"],
  },
  {
    id: "ai-credit",
    title: "AI credit in commits",
    text: "Kept out means commits, PRs and comments carry no generated-with lines or AI co-author "
      + "credit, and a guard blocks them.",
    value: "Kept out",
    keys: ["advanced.attributionGuard"],
    engine: [{ flags: {}, key: "advanced.attributionGuard", value: true }],
  },
  {
    id: "ai-review",
    title: "AI review on every pull request",
    text: "An AI reviewer checks every pull request before it merges.",
    value: "On",
    keys: ["advanced.aiReview"],
    engine: [{ flags: {}, key: "advanced.aiReview", value: true }],
  },
  {
    id: "deep-review",
    title: "Deeper review on risky changes",
    text: "Changes that touch risky code, such as security or saved data, get a second, deeper review. "
      + "Needs the AI review.",
    value: "On",
    keys: ["advanced.deepEscalation"],
    engine: [{ flags: {}, key: "advanced.deepEscalation", value: true }],
  },
  {
    id: "code-size",
    title: "Code-size check",
    text: "A check that fails when code grows past the size limits.",
    value: "On",
    keys: ["advanced.codeSizeCheck"],
    engine: [{ flags: {}, key: "advanced.codeSizeCheck", value: true }],
  },
  {
    id: "plain-writing",
    title: "Plain-language writing",
    text: "Replies, docs and commit text in plain words that try to sound like you wrote them "
      + "(it's still an AI writing them ;V).",
    value: "On",
    keys: ["advanced.plainWriting"],
    engine: [{ flags: {}, key: "advanced.plainWriting", value: true }],
  },
  {
    id: "visual-steps",
    title: "Visual changes in small steps",
    text: "Changes to anything people see are made in small steps, each checked before the next.",
    value: "On",
    keys: ["advanced.uiRule"],
    engine: [{ flags: {}, key: "advanced.uiRule", value: true }],
  },
  {
    id: "work-state",
    title: "Where the work state lives",
    text: "A GitHub board with the issues plus a short hand-off note, GitHub issues only, or a detailed "
      + "hand-off file in the repo.",
    value: "GitHub board and a short hand-off note",
    keys: ["advanced.tracker", "advanced.handoffFile", "advanced.trackerProject"],
  },
  {
    id: "work-items-repo",
    title: "Private repo for work items",
    text: "Asked only when the code is public, since a public repo's issues are public too. Keeps the "
      + "work items in a private repo.",
    value: "Yes (recommended)",
    keys: ["advanced.trackerRepo"],
  },
  {
    id: "board-visibility",
    title: "Board visibility",
    text: "The board holds the full engineering details and stays private. A clean public copy for "
      + "outsiders is optional, and making the full board public gets a clear warning first.",
    value: "Private",
    keys: ["advanced.publicRoadmap"],
    engine: [{ flags: {}, key: "advanced.publicRoadmap", value: null }],
  },
];

export const FIXED = [
  {
    id: "name-and-repo",
    title: "Project name, repo address and license holder",
    text: "Read from the repo folder, its git remote and your git name.",
    value: "Read from the repo",
    keys: ["project.name", "project.repoUrl", "project.licenseHolder"],
  },
  {
    id: "license",
    title: "License",
    text: "Picked from your answers: MIT for your own public project, Proprietary otherwise.",
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
    text: "Gitflow: main for releases and develop for work. main stays the default branch on GitHub.",
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
    text: "Every pull request merges with a merge commit, so each branch stays visible in the history.",
    value: "Merge commits",
    keys: ["advanced.mergeStyle"],
    engine: [{ flags: {}, key: "advanced.mergeStyle", value: "merge" }],
  },
  {
    id: "pre-commit",
    title: "Pre-commit hook",
    text: "None alone. A team gets lefthook, which runs checks before each commit.",
    value: "None alone, lefthook for a team",
    keys: ["advanced.precommit"],
    engine: [
      { flags: {}, key: "advanced.precommit", value: "none" },
      { flags: { team: true }, key: "advanced.precommit", value: "lefthook" },
    ],
  },
  {
    id: "guard-location",
    title: "Where the guards live",
    text: "In the repo, so everyone who clones it gets them. The other choice puts them only in each "
      + "person's ~/.claude.",
    value: "In the repo",
    keys: ["advanced.hookLocation", "extra:attribution-guard"],
    engine: [{ flags: {}, key: "advanced.hookLocation", value: "repo" }],
  },
  {
    id: "blocked-commands",
    title: "Blocked commands",
    text: "The standard list of commands the assistant may never run.",
    value: "Standard",
    keys: ["advanced.denyProfile"],
    engine: [{ flags: {}, key: "advanced.denyProfile", value: "standard" }],
  },
  {
    id: "architecture",
    title: "Architecture rule",
    text: "An optional folder layout the assistant follows: none, clean, ddd, ecs, feature-based, "
      + "hexagonal, layered or mvc.",
    value: "None",
    keys: ["advanced.architecture"],
    engine: [{ flags: {}, key: "advanced.architecture", value: "none" }],
  },
  {
    id: "confidentiality",
    title: "Confidentiality rule",
    text: "Added for someone else's private project, where the assistant follows a confidentiality rule.",
    value: "On for someone else's private project",
    keys: ["advanced.confidentiality"],
    engine: [
      { flags: { client: true }, key: "advanced.confidentiality", value: true },
      { flags: {}, key: "advanced.confidentiality", value: false },
    ],
  },
  {
    id: "clean-room",
    title: "Clean-room rule",
    text: "For projects derived from an existing work. It keeps what ships free of copied material.",
    value: "Off",
    keys: ["advanced.cleanRoom"],
    engine: [{ flags: {}, key: "advanced.cleanRoom", value: false }],
  },
  {
    id: "shipped-text",
    title: "Files the writing rule checks",
    text: "The files the plain-language writing rule checks. Setup uses the rule's own list.",
    value: "The rule's own list",
    keys: ["advanced.shippedTextPaths"],
    engine: [{ flags: {}, key: "advanced.shippedTextPaths", value: null }],
  },
];

// One row per mod in the engine's MODS list, in the same order. The title is the mod's name.
export const MODS_ROWS = [
  {
    id: "ci-watch",
    text: "After a push, watches the pull request's checks and wakes the session once they have all settled.",
    value: "Optional",
  },
  {
    id: "compact-handoff",
    text: "Turns compaction into a focused hand-off and adds a recall tool that searches the whole "
      + "transcript afterwards.",
    value: "Optional",
  },
  {
    id: "mods",
    text: "Opens a pane that lists every installed mod, what it does and the slash commands it adds.",
    value: "Optional",
  },
  {
    id: "runners",
    text: "Shows one row per local CI runner you list, whether it is running and when its next run is "
      + "due, with start and stop buttons.",
    value: "Optional",
  },
  {
    id: "session-facts",
    text: "Tells the assistant the time, how full its context is and your plan usage on every "
      + "prompt, and shows you the same in a row above the prompt.",
    value: "Recommended",
  },
  {
    id: "session-info",
    text: "Adds one row above the prompt with the model, the project, the git branch and the changed files.",
    value: "Optional",
  },
  {
    id: "shared-pc",
    text: "Lets one session at a time hold the computer for heavy work like builds and full test suites; "
      + "the rest wait in a visible line.",
    value: "Optional",
  },
  {
    id: "skill-check",
    text: "Checks that a skill ran every step its contract requires, and asks for the ones it missed.",
    value: "Optional",
  },
  {
    id: "tasks",
    text: "Keeps the task list honest: one task in progress, a list that survives compaction, and a nudge "
      + "to carry on when work is left.",
    value: "Optional",
  },
  {
    id: "usage-guard",
    text: "Near a plan limit, has every session save its work, then resumes them after the limit resets.",
    value: "Optional",
  },
];

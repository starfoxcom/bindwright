// What /bindwright:setup writes, for the "what lands where" scene. `path` is what the
// box shows. `key` names the row's text: lands.item.<key> in the i18n dictionaries.
// engine/test/page-lands.test.js checks that every path is a file setup writes.
export const computer = [
  { key: "plugin", path: "~/.claude/plugins/" },
  { key: "global-rules", path: "~/.claude/CLAUDE.md" },
  { key: "memory", path: "~/.claude/memory/MEMORY.md" },
  { key: "guard", path: "~/.claude/hooks/push-guard.py" },
  { key: "mods", path: "~/.claude/mods/" },
];

export const project = [
  { key: "brief", path: "CLAUDE.md" },
  { key: "rules", path: ".claude/rules/" },
  { key: "routines", path: ".claude/skills/" },
  { key: "guards", path: ".claude/hooks/" },
  { key: "review", path: ".github/workflows/" },
  { key: "board", path: ".bindwright/project.json" },
];

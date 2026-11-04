// The scripted scene for each mod, played in the mods section's terminal. Each scene is a
// list of steps, run in order by mods.js:
//   ["say", key]               a line from the assistant, text from the dictionary
//   ["out", key, tone]         a result line; tone is a class from the terminal's styles
//   ["type", text]             a typed prompt, sent as is
//   ["tool", name, arg, ms]    a tool call that turns to its result after ms
//   ["wait", ms]               a pause
// The keys are the dictionary's texts, and engine/test/page-mods.test.js checks each one
// exists in every language.

export const SCENES = {
  "ci-watch": [
    ["tool", "Bash", "gh pr checks 14", 700],
    ["out", "mods.scene.ci-watch.running", "mute"],
    ["wait", 1800],
    ["out", "mods.scene.ci-watch.passed", "okt"],
    ["say", "mods.scene.ci-watch.wake"],
    ["wait", 2000],
  ],
  "compact-handoff": [
    ["say", "mods.scene.compact-handoff.compacting"],
    ["wait", 1200],
    ["out", "mods.scene.compact-handoff.kept", "mute"],
    ["out", "mods.scene.compact-handoff.words", "mute"],
    ["wait", 1800],
    ["say", "mods.scene.compact-handoff.resume"],
    ["wait", 2000],
  ],
  "mods": [
    ["type", "/mods"],
    ["out", "mods.scene.mods.list", "mute"],
    ["wait", 2400],
  ],
  "runners": [
    ["type", "/runners"],
    ["tool", "Bash", "runners status", 600],
    ["out", "mods.scene.runners.status", "mute"],
    ["wait", 1200],
    ["out", "mods.scene.runners.start", "okt"],
    ["wait", 2000],
  ],
  "session-facts": [
    ["say", "mods.scene.session-facts.facts"],
    ["wait", 1200],
    ["out", "mods.scene.session-facts.use", "mute"],
    ["wait", 2000],
  ],
  "session-info": [
    ["say", "mods.scene.session-info.row"],
    ["wait", 1200],
    ["tool", "Bash", "git switch feature/coupons", 600],
    ["say", "mods.scene.session-info.switched"],
    ["wait", 2000],
  ],
  "shared-pc": [
    ["tool", "Bash", "npm run test:all", 600],
    ["out", "mods.scene.shared-pc.queued", "mute"],
    ["wait", 2000],
    ["out", "mods.scene.shared-pc.turn", "okt"],
    ["wait", 1200],
  ],
  "skill-check": [
    ["tool", "Skill", "session-close", 600],
    ["out", "mods.scene.skill-check.missing", "badt"],
    ["wait", 1500],
    ["out", "mods.scene.skill-check.rerun", "okt"],
    ["wait", 1800],
  ],
  "tasks": [
    ["tool", "TaskCreate", "3 items", 500],
    ["tool", "TaskUpdate", "#2 in progress", 500],
    ["out", "mods.scene.tasks.carry", "mute"],
    ["wait", 2000],
  ],
  "usage-guard": [
    ["say", "mods.scene.usage-guard.near"],
    ["wait", 1200],
    ["out", "mods.scene.usage-guard.save", "okt"],
    ["wait", 1800],
    ["say", "mods.scene.usage-guard.resume"],
    ["wait", 2000],
  ],
};

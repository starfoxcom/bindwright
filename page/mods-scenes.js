// The scripted scene for each mod, played in the mods section's terminal. Each scene is a
// list of steps, run in order by mods.js:
//   ["say", key]               a line from the assistant, text from the dictionary
//   ["out", key, tone]         a result line; tone is a class from the terminal's styles
//   ["type", text]             a typed prompt, sent as is
//   ["tool", name, arg, ms]    a tool call that turns to its result after ms
//   ["think", key, ms, tokens] the spinner row, its verb from the dictionary
//   ["band", rows]             the status rows above the input box, set to these rows
//   ["wait", ms]               a pause
// The keys are the dictionary's texts, and engine/test/page-mods.test.js checks each one
// exists in every language. Band rows are English, as the mods print them, so they are
// not keys.

// The order the band's rows stack in, top to bottom.
export const BAND_ORDER = ["session", "ci", "runners", "budgets", "usage", "tasks", "pc"];

// The compaction point, in thousands of tokens. The context left is this, less the share used.
const COMPACT_POINT_K = 400;
const YELLOW_CONTEXT = 75;
const RED_CONTEXT = 90;
const WARN_PLAN = 80;
const WRAP_UP_PLAN = 90;

const row = (kind, html) => ({ kind, html });
const tone = (cls, text) => (cls ? `<span class="${cls}">${text}</span>` : text);
const btn = (label) => tone("btn", `[${label}]`);

function contextTone(percent) {
  if (percent >= RED_CONTEXT) return "badt";
  if (percent >= YELLOW_CONTEXT) return "warnt";
  return "okt";
}

// The context chip: ten cells filled to the share used, then the figures. Only yellow and
// red colour the words as well as the cells.
function contextChip({ percent, justCompacted }) {
  const cls = contextTone(percent);
  const filled = Math.round(percent / 10);
  const cells = tone(cls, "▰".repeat(filled)) + tone("mute", "▱".repeat(10 - filled));
  const left = Math.round(COMPACT_POINT_K * (100 - percent) / 100);
  const compacted = justCompacted ? ` · just compacted ${justCompacted}` : "";
  const words = `ctx ${cells} ${percent}% · ${left}k to compact${compacted}`;
  return cls === "okt" ? words : tone(cls, words);
}

// A plan window's chip. Past its warning level it shows its reset time, yellow until the
// wrap-up level and red from it. A usage-guard pause replaces the reset with the pause.
function planChip(label, percent, { reset, pausedUntil }) {
  const text = `${label} ${percent}%`;
  if (pausedUntil) return `${text} ${tone("badt", `PAUSED → ${pausedUntil}`)}`;
  if (!reset || percent < WARN_PLAN) return text;
  return tone(percent >= WRAP_UP_PLAN ? "badt" : "warnt", `${text} → resets ${reset}`);
}

// The budgets row: the context chip, the 5-hour window and the week, joined by dots.
const budgets = (state = {}) => {
  const facts = { percent: 41, fiveHour: 38, ...state };
  return row("budgets", [
    contextChip(facts),
    planChip("5h", facts.fiveHour, facts),
    "week 62%",
  ].join(" · "));
};

const usage = row("usage", "⏰ resumes 15:10 · after the 5-hour reset · used 5h 94%, week 62%");

// The session row: the model, project and branch. With changes the branch gets a star and
// a button for the changed files.
const session = (branch, changed = 0) => row("session", changed
  ? `Opus 5.5 high · shop · ${branch}* ${btn(`${changed} changed`)}`
  : `Opus 5.5 high · shop · ${branch}`);

const runners = (online) => row("runners", `runners on · ${online} online`);

const CI_BUTTONS = [btn("open"), btn("checks"), btn("stop")].join(" ");
const ci = (text, cls) => row("ci", `${tone(cls, text)} ${CI_BUTTONS}`);

// The tasks row: the count done, the task in progress, and how many are still to do.
function tasks({ done, total, current, pending }) {
  const count = `✅ ${done}/${total}`;
  const parts = [done === total ? tone("okt", count) : count];
  if (current) parts.push(tone("now", `🔨 ${current}`));
  if (pending) parts.push(`📝 ${pending} ${btn("List")}`);
  return row("tasks", parts.join(" · "));
}

const PC_FREE = row("pc", tone("okt", "PC · free"));
const PC_QUEUED = row("pc", tone("cyant",
  `PC · #2 in line · api has it (benchmark, 3m) ${btn("Go next")}`));
const PC_YOURS = row("pc", tone("okt", `PC · yours · npm run test:all · 12s ${btn("Release")}`));

// The rows the all-together scene shows at once, in band order.
function board({ changed, task, facts, pc = PC_FREE, check }) {
  return [session("main", changed), check, runners(2), budgets(facts), tasks(task), pc]
    .filter(Boolean);
}

// The task list's states, in the order a session works through them.
const READING = { done: 0, total: 3, current: "#1 Reading the cart code", pending: 2 };
const CODING = { done: 1, total: 3, current: "#2 Adding the coupon field", pending: 1 };
const WRITING = { done: 2, total: 3, current: "#3 Writing the tests" };
const FINISHED = { done: 3, total: 3 };

// The board once the coupon work is pushed: only the CI row changes from step to step.
const pushed = (check) => board({ changed: 2, task: FINISHED, facts: { percent: 47 }, check });

export const SCENES = {
  "all": [
    ["band", board({ task: READING })],
    ["say", "mods.scene.all.start"],
    ["wait", 1200],
    ["type", "add coupon codes to the cart"],
    ["say", "mods.scene.all.plan"],
    ["wait", 900],
    ["tool", "TaskUpdate", "#1 done", 400],
    ["band", board({ task: CODING })],
    ["tool", "Update", "src/cart.js", 500],
    ["band", board({ changed: 1, task: CODING })],
    ["tool", "Bash", "npm run test:all", 500],
    ["band", board({ changed: 1, task: CODING, pc: PC_YOURS })],
    ["wait", 1200],
    ["out", "mods.scene.all.tested", "okt"],
    ["band", board({ changed: 1, task: CODING })],
    ["tool", "TaskUpdate", "#2 done", 400],
    ["tool", "Update", "src/coupon.js", 500],
    ["band", board({ changed: 2, task: WRITING, facts: { percent: 47 } })],
    ["tool", "TaskUpdate", "#3 done", 400],
    ["tool", "Bash", "gh pr create --base develop", 600],
    ["band", pushed(ci("⏳ PR 14 · 1/4 done"))],
    ["wait", 800],
    ["band", pushed(ci("⏳ PR 14 · 3/4 done"))],
    ["wait", 800],
    ["band", pushed(ci("⏳ PR 14 · all 4 passed, confirming"))],
    ["wait", 800],
    ["band", pushed(ci("✅ PR 14 · all 4 passed", "okt"))],
    ["say", "mods.scene.ci-watch.wake"],
    ["wait", 2000],
  ],
  "ci-watch": [
    ["tool", "Bash", "git push -u origin feature/coupons", 600],
    ["tool", "Bash", "gh pr create --base develop", 700],
    ["band", [ci("⏳ PR 14 · 1/4 done")]],
    ["wait", 900],
    ["band", [ci("⏳ PR 14 · 2/4 done")]],
    ["wait", 900],
    ["band", [ci("⏳ PR 14 · 3/4 done")]],
    ["wait", 900],
    ["band", [ci("⏳ PR 14 · all 4 passed, confirming")]],
    ["wait", 900],
    ["band", [ci("✅ PR 14 · all 4 passed", "okt")]],
    ["say", "mods.scene.ci-watch.wake"],
    ["wait", 1800],
    ["band", []],
    ["wait", 1000],
  ],
  "compact-handoff": [
    ["band", [budgets({ percent: 92 })]],
    ["say", "mods.scene.compact-handoff.compacting"],
    ["wait", 1200],
    ["think", "mods.scene.compact-handoff.spinner", 2400, 9],
    ["band", [budgets({ percent: 8, justCompacted: "14:40" })]],
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
    ["band", [runners(1)]],
    ["type", "/runners"],
    ["tool", "Bash", "runners status", 600],
    ["out", "mods.scene.runners.status", "mute"],
    ["out", "mods.scene.runners.running", "mute"],
    ["out", "mods.scene.runners.stopped", "mute"],
    ["wait", 1200],
    ["out", "mods.scene.runners.start", "okt"],
    ["band", [runners(2)]],
    ["wait", 2000],
  ],
  "session-facts": [
    ["band", [budgets()]],
    ["say", "mods.scene.session-facts.facts"],
    ["wait", 1200],
    ["out", "mods.scene.session-facts.use", "mute"],
    ["wait", 1200],
    ["tool", "Bash", "git status", 600],
    ["band", [budgets({ percent: 44 })]],
    ["wait", 2000],
  ],
  "session-info": [
    ["band", [session("main")]],
    ["wait", 1200],
    ["tool", "Update", "src/cart.js", 600],
    ["band", [session("main", 1)]],
    ["wait", 1200],
    ["tool", "Bash", "git switch -c feature/coupons", 600],
    ["band", [session("feature/coupons", 1)]],
    ["wait", 2000],
  ],
  "shared-pc": [
    ["band", [PC_QUEUED]],
    ["tool", "Bash", "npm run test:all", 600],
    ["out", "mods.scene.shared-pc.queued", "mute"],
    ["wait", 2000],
    ["band", [PC_YOURS]],
    ["out", "mods.scene.shared-pc.turn", "okt"],
    ["wait", 1200],
    ["band", [PC_FREE]],
    ["wait", 1000],
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
    ["band", [tasks(READING)]],
    ["wait", 1200],
    ["tool", "TaskUpdate", "#1 done", 500],
    ["band", [tasks(CODING)]],
    ["wait", 1200],
    ["tool", "TaskUpdate", "#2 done", 500],
    ["band", [tasks(WRITING)]],
    ["out", "mods.scene.tasks.carry", "mute"],
    ["wait", 2000],
  ],
  "usage-guard": [
    ["band", [budgets({ percent: 58, fiveHour: 94, reset: "15:10" }), usage]],
    ["say", "mods.scene.usage-guard.near"],
    ["wait", 1200],
    ["out", "mods.scene.usage-guard.save", "okt"],
    ["band", [budgets({ percent: 58, fiveHour: 94, pausedUntil: "15:10" }), usage]],
    ["wait", 1800],
    ["band", [budgets({ percent: 58, fiveHour: 4 })]],
    ["say", "mods.scene.usage-guard.resume"],
    ["wait", 2000],
  ],
};

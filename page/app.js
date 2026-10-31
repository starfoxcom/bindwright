// The page's state and controls. The engine's own model holds the answers,
// so the page and /bindwright:setup always start from the same defaults.
import { defaults } from "../engine/model.js";
import { repoFiles, byFolder } from "./files.js";
import { summarize, compare } from "./summary.js";
import { encodeSetupCode } from "../engine/setupcode.js";

// One accent hue per setup (docs/v2/DESIGN.md).
const HUES = { "false,false": 150, "true,false": 200, "false,true": 70, "true,true": 340 };
const hueFor = (team, client) => HUES[`${team},${client}`];
const $ = (id) => document.getElementById(id);
const questions = [...document.querySelectorAll(".q")];
const questionOf = (node) => node.querySelector("[data-q]").dataset.q;
const ADVANCE_MS = 350;
const RISE_STEP_MS = 90;
const DISSOLVE_STEP_MS = 70;
const DISSOLVE_MS = 700;
const TALLY_MS = 500;
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const mix = (from, to, t) => Math.round(from + (to - from) * t);
const ruleCount = (groups) => groups.reduce((sum, group) => sum + (group.rules?.length ?? 0), 0);
const filesOpen = () => !$("files").classList.contains("away");

// Restarts the one-shot CSS animation that the named class sets on the node.
function restart(node, name) {
  if (still()) return;
  node.classList.remove(name);
  void node.offsetWidth;
  node.classList.add(name);
}

let answers = defaults();
// The questions the reader has picked an answer for.
const answered = new Set();
let files = [];
let selected = "CLAUDE.md";
let latest = 0;
// The summary on screen.
let shown = [];
// The state before the last answer; the tags compare with it.
let baseline = emptyState();
// The question index of the last answer picked, or -1 before any answer.
let lastAnswer = -1;
// Each item's New or Changed tag and the answer that made it, keyed like data-key.
const tagHistory = new Map();
let fileChange = null;
// The tally on screen, counting toward the summary's numbers.
let tally = { parts: 0, rules: 0 };
let tallyFrame = 0;
// Set while the summary dissolves before the page starts over.
let dissolving = false;
let snapTimer = 0;
// The state on screen just before each question's answer was picked.
const snapshots = new Map();
// The setup step on screen: a question's index, or questions.length for Done.
let step = 0;
let copyTimer = 0;

// The engine's defaults for these answers. Private is the engine's isPrivate
// argument, so it is passed on under that name.
function setupFor(parts) {
  return defaults({ team: parts.team, client: parts.client, isPrivate: parts.private });
}

function choose(question, value) {
  if (dissolving) return;
  if (!answered.has(question) || answers[question] !== value) {
    // Before the first answer nothing is shown, files included.
    baseline = answered.size ? { cards: shown, files: new Map(files) } : emptyState();
    snapshots.set(question, baseline);
  }
  answered.add(question);
  lastAnswer = questions.findIndex((node) => questionOf(node) === question);
  // A new pick on this question replaces the tags its earlier pick left.
  for (const [key, entry] of tagHistory) if (entry.answer >= lastAnswer) tagHistory.delete(key);
  // A new setup starts from that setup's defaults, as setup itself does.
  if (answers[question] !== value) answers = setupFor({ ...answers, [question]: value });
  render();
}

// Answer from a key, then move to the next step after a short pause. A pause
// that finds the reader on another step does nothing.
function pick(key) {
  if (dissolving) return;
  const from = questions.indexOf(key.closest(".q"));
  choose(key.dataset.q, key.dataset.v === "true");
  setTimeout(() => { if (step === from) show(from + 1); }, ADVANCE_MS);
}

// Keys 1 and 2 pick that answer of the current question, unless a text field has focus.
function pickByDigit(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest("input, textarea, select, [contenteditable]")) return;
  const keys = questions[step]?.querySelectorAll(".k") ?? [];
  const key = keys[Number(event.key) - 1];
  if (key) pick(key);
}

// Keyboard focus on the step being left moves to the new step's heading.
function show(next) {
  const leaving = $("stage").contains(document.activeElement);
  const crossesDone = (next === questions.length) !== (step === questions.length);
  step = next;
  paintStage();
  // The tags compare with a different state on the Done card, so the files and cards redraw.
  if (crossesDone) refresh();
  if (leaving) stageHeading().focus({ preventScroll: true });
}

function stageHeading() {
  const node = step < questions.length ? questions[step] : $("done");
  return node.querySelector("h3");
}

// Hides a node but keeps its room (the "off" class), so nothing around it moves.
// A stage step that comes back rises in again.
function setShown(node, visible) {
  if (visible && node.classList.contains("off") && node.closest(".stage")) restart(node, "rise-in");
  node.classList.toggle("off", !visible);
}

function paintStage() {
  questions.forEach((node, i) => setShown(node, i === step));
  setShown($("done"), step === questions.length);
  setShown($("back"), step > 0);
  [...$("steps").children].forEach((dot, i) => {
    if (i === step) dot.setAttribute("aria-current", "step");
    else dot.removeAttribute("aria-current");
  });
}

// One progress dot per question plus the final Done step. The dots only show
// progress: Back moves one step at a time and Edit answers starts over.
function buildSteps() {
  const labels = [...questions.map((_, i) => `Question ${i + 1}`), "Done"];
  const dots = labels.map((label) => {
    const dot = el("li", { className: "dot" });
    dot.setAttribute("aria-label", label);
    return dot;
  });
  $("steps").replaceChildren(...dots);
}

// Whose project and who can see it, in plain words.
function ownerWords() {
  const owner = answers.client ? "someone else's" : "my own";
  return `${owner} ${answers.private ? "private" : "public"} project`;
}

// The answers in plain words, e.g. "Just me, my own project".
function plainAnswers() {
  const team = answers.team ? "A team" : "Just me";
  return `${team}, ${ownerWords()}`;
}

function commandLine() {
  return `/bindwright:setup ${encodeSetupCode(answers)}`;
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(commandLine());
    $("copy").textContent = "Copied";
    restart($("copy"), "pulse");
  } catch {
    $("copy").textContent = "Select and copy";
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
}

function render() {
  const { team, client } = answers;
  document.documentElement.style.setProperty("--hue", hueFor(team, client));
  for (const key of document.querySelectorAll(".k[data-q]")) {
    const value = key.dataset.v === "true";
    const question = key.dataset.q;
    const picked = answered.has(question) && answers[question] === value;
    key.setAttribute("aria-pressed", String(picked));
    // The key's light shows the setup that pressing it would give.
    const next = { team, client, [question]: value };
    key.style.setProperty("--h", hueFor(next.team, next.client));
  }
  const ready = answered.size === questions.length;
  $("cmd-text").textContent = commandLine();
  $("command").hidden = !ready;
  setShown($("switch"), ready);
  $("idle").hidden = answered.size > 0;
  const line = plainAnswers();
  if (line !== $("done-line").textContent) restart($("done"), "fade-up");
  $("done-line").textContent = line;
  paintStage();
  refresh();
}

// Re-render the files; only the newest request draws, so fast clicks never
// leave an older setup on screen.
async function refresh() {
  const ticket = ++latest;
  try {
    const next = await repoFiles(answers);
    if (ticket !== latest) return;
    // What the files did against the state before the last answer; none before an answer.
    fileChange = answered.size ? diffFiles(baseline.files, new Map(next)) : null;
    files = next;
    if (!files.some(([path]) => path === selected)) selected = files[0]?.[0];
    drawGroups();
    drawTree();
    settleTags();
    drawFile();
    $("status").textContent = "What you get is updated.";
  } catch (err) {
    if (ticket !== latest) return;
    const fail = document.createElement("li");
    fail.textContent = `This part of the page could not load (${err.message || err}). Reload the page to try again.`;
    $("groups").replaceChildren(fail);
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function emptyState() {
  return { cards: [], files: new Map() };
}

// The word on an item's badge, and the class that colours its row.
const TAG_CLASS = { New: "added", Changed: "changed", Removed: "removed" };

// New, Changed or no tag for an id, given the sets a comparison made.
function tagOf(id, added, changed = new Set()) {
  if (added.has(id)) return "New";
  return changed.has(id) ? "Changed" : "";
}

// Stamps the item's history key and its badge word; an empty word leaves it
// untagged, and a removed item passes no key because its tag is never kept.
function tagged(node, word, key = "") {
  if (key) node.dataset.key = key;
  if (word) node.dataset.tag = word;
  return node;
}

// Keeps each item's New or Changed tag under the answer that made it. This draw's
// lit tags are stored, and an item this draw leaves untagged shows its stored tag dimmed.
function settleTags() {
  const nodes = [...document.querySelectorAll("[data-key]")];
  const present = new Set(nodes.map((node) => node.dataset.key));
  for (const key of tagHistory.keys()) if (!present.has(key)) tagHistory.delete(key);
  for (const node of nodes) {
    const { key } = node.dataset;
    if (node.dataset.tag) {
      // The first question's tags compare with nothing, so they are not kept.
      if (lastAnswer > 0) tagHistory.set(key, { word: node.dataset.tag, answer: lastAnswer });
    } else if (tagHistory.has(key)) {
      node.dataset.tag = tagHistory.get(key).word;
      node.dataset.stale = "";
    }
  }
}

// The summary. Cards the setup adds rise in list order; cards it removes
// dissolve as they leave. Every card is drawn again, tagged against the tag base.
function drawGroups() {
  const next = answered.size ? summarize(files, answers) : [];
  const motion = compare(shown, next);
  const tags = compare(baseline.cards, next);
  shown = next;
  let risen = 0;
  const items = next.map((group) => {
    const added = motion.addedGroups.has(group.id);
    const title = tagged(el("b", { textContent: group.title }),
      tagOf(group.id, tags.addedGroups, tags.changedGroups), `g:${group.id}`);
    const item = el("li", {}, title, el("p", { textContent: group.say }));
    item.dataset.id = group.id;
    if (added) {
      item.className = "enter";
      item.style.animationDelay = `${risen++ * RISE_STEP_MS}ms`;
    }
    const facts = factsList(group, tags);
    if (facts.childElementCount) item.append(facts);
    if (group.rules) {
      item.classList.add("has-rules");
      item.append(rulesList(group.rules, tags));
    }
    return item;
  });
  items.push(...departing(motion.removedGroups));
  $("groups").replaceChildren(...items);
  countTally(next);
  setFilesView(filesOpen());
}

// Groups the last change removed, struck through, then gone once they dissolve.
function departing(gone) {
  if (still()) return [];
  return gone.map((group, i) => {
    const title = tagged(el("b", { textContent: group.title }), "Removed");
    const item = el("li", { className: "removed leaving" },
      title, el("p", { textContent: group.say }));
    item.style.animationDelay = `${i * DISSOLVE_STEP_MS}ms`;
    item.addEventListener("animationend", () => item.remove(), { once: true });
    return item;
  });
}

// The tally counts from its old numbers to the new ones over TALLY_MS.
function countTally(groups) {
  const to = { parts: groups.length, rules: ruleCount(groups) };
  const from = tally;
  const start = performance.now();
  cancelAnimationFrame(tallyFrame);
  const frame = (now) => {
    const t = still() ? 1 : Math.min(Math.max(now - start, 0) / TALLY_MS, 1);
    tally = { parts: mix(from.parts, to.parts, t), rules: mix(from.rules, to.rules, t) };
    paintTally();
    if (t < 1) tallyFrame = requestAnimationFrame(frame);
  };
  frame(start);
}

// "· 6 parts, 23 rules" after the heading; empty until the first answer.
function paintTally() {
  const { parts, rules } = tally;
  const text = `· ${count(parts, "part")}, ${count(rules, "rule")}`;
  $("tally").textContent = answered.size ? text : "";
}

// The card's detail lines: each tagged New or Changed, and the ones the change
// removed kept on screen, struck through.
function factsList(group, tags) {
  const rows = group.facts.map((fact) => {
    const word = tagOf(fact.id, tags.addedFacts, tags.changedFacts);
    const text = tagged(el("span", { textContent: fact.text }), word, `f:${fact.id}`);
    return el("li", { className: TAG_CLASS[word] ?? "" }, text);
  });
  for (const fact of tags.removedFacts.filter((f) => f.group === group.id)) {
    rows.push(el("li", { className: "removed" }, tagged(el("span", { textContent: fact.text }), "Removed")));
  }
  return el("ul", { className: "facts" }, ...rows);
}

// The rules card's rows: rules the change added are New, rules it removed stay struck through.
function rulesList(rules, tags) {
  const rows = rules.map(([name, line], i) => {
    const word = tagOf(name, tags.addedRules);
    const row = el("li", { className: TAG_CLASS[word] ?? "" },
      tagged(el("b", { textContent: name }), word, `r:${name}`), ` ${line}`);
    row.style.setProperty("--i", i);
    return row;
  });
  for (const name of tags.removedRules) {
    const title = tagged(el("b", { textContent: name }), "Removed");
    rows.push(el("li", { className: "removed" }, title));
  }
  return el("ul", { className: "rules" }, ...rows);
}

// Folder rows wherever a path enters a new folder, then the file itself. Files
// the last change added or edited are tagged; removed ones stay, struck through.
function drawTree() {
  const rows = [];
  let open = [];
  const removed = new Set(fileChange?.removed ?? []);
  const paths = [...files.map(([path]) => path), ...removed].sort(byFolder);
  for (const path of paths) {
    const parts = path.split("/");
    const dirs = parts.slice(0, -1);
    let same = 0;
    while (same < dirs.length && open[same] === dirs[same]) same++;
    for (let d = same; d < dirs.length; d++) rows.push(row("div", "dir", d, `${dirs[d]}/`));
    open = dirs;
    if (removed.has(path)) {
      rows.push(tagged(row("div", "file removed", dirs.length, parts.at(-1)), "Removed"));
      continue;
    }
    const word = fileTag(path);
    const kind = `file ${TAG_CLASS[word] ?? ""}`.trim();
    const file = tagged(row("button", kind, dirs.length, parts.at(-1)), word, `p:${path}`);
    file.type = "button";
    file.dataset.path = path;
    if (path === selected) file.setAttribute("aria-current", "true");
    rows.push(file);
  }
  $("tree").replaceChildren(...rows);
}

function row(tag, kind, depth, text) {
  const node = el(tag, { className: kind, textContent: text });
  node.style.setProperty("--d", depth);
  return node;
}

// The file's badge: New when added, Changed when its text differs, or none.
function fileTag(path) {
  if (fileChange?.added.has(path)) return "New";
  return fileChange?.changed.has(path) ? "Changed" : "";
}

// The added, removed and edited files against the state before the last answer.
// `previousText` keeps that state's texts, for the line marks.
function diffFiles(previous, now) {
  return {
    added: new Set([...now.keys()].filter((path) => !previous.has(path))),
    removed: [...previous.keys()].filter((path) => !now.has(path)),
    changed: new Set([...now]
      .filter(([path, text]) => previous.has(path) && previous.get(path) !== text)
      .map(([path]) => path)),
    previousText: previous,
  };
}

function drawFile() {
  const file = files.find(([path]) => path === selected);
  $("path").textContent = file ? file[0] : "";
  if (file && fileChange?.changed.has(file[0])) drawChangedCode(file[0], file[1]);
  else $("code").textContent = file ? file[1] : "";
  $("code").scrollTop = 0;
}

// An edited file's code, one element per line; lines the old text had no copy of are marked.
function drawChangedCode(path, text) {
  const fresh = newLines(fileChange.previousText.get(path), text);
  const lines = text.split("\n").map((line, i) => el("span", {
    className: fresh[i] ? "line line-new" : "line", textContent: line,
  }));
  $("code").replaceChildren(...lines);
}

// For each line of the new text, whether the old text has no spare copy of it.
function newLines(oldText, newText) {
  const spare = new Map();
  for (const line of oldText.split("\n")) spare.set(line, (spare.get(line) ?? 0) + 1);
  return newText.split("\n").map((line) => {
    const left = spare.get(line) ?? 0;
    if (left > 0) spare.set(line, left - 1);
    return left === 0;
  });
}

$("tree").addEventListener("click", (event) => {
  const file = event.target.closest(".file");
  if (!file || file.dataset.path === selected) return;
  selected = file.dataset.path;
  for (const node of $("tree").querySelectorAll(".file")) {
    if (node === file) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
  drawFile();
  restart($("code").parentElement, "swap");
});

// The summary and the file tree take turns in the same panel. The view that
// leaves fades and slides out, the one that comes in fades up. Neither is
// rebuilt, so the summary's cards keep their place and do not rise again.
function setFilesView(open) {
  const view = open ? "files" : "overview";
  const panel = $("files");
  const groups = $("groups");
  if (panel.classList.contains("away") === open) {
    const [leaving, arriving] = open ? [groups, panel] : [panel, groups];
    leaving.classList.remove("arrive");
    leaving.classList.add("away", "leave");
    arriving.classList.remove("away", "leave");
    arriving.classList.add("arrive");
  }
  $("switch").dataset.view = view;
  for (const opt of $("switch").querySelectorAll(".seg-opt")) {
    opt.setAttribute("aria-pressed", String(opt.dataset.view === view));
  }
  $("files-opt").textContent = `Files · ${files.length}`;
}

// Dissolves the given summary items, from the last one up, then calls done once.
function snap(items, done) {
  if (dissolving) return;
  dissolving = true;
  const finish = () => {
    if (!dissolving) return;
    clearTimeout(snapTimer);
    dissolving = false;
    done();
  };
  if (still() || items.length === 0) {
    finish();
    return;
  }
  items.forEach((item, i) => {
    item.classList.add("leaving");
    item.style.animationDelay = `${(items.length - 1 - i) * DISSOLVE_STEP_MS}ms`;
  });
  // The first item starts last, so it ends last; the timer covers a missed event.
  const last = items[0];
  last.addEventListener("animationend", (event) => { if (event.target === last) finish(); });
  snapTimer = setTimeout(finish, (items.length - 1) * DISSOLVE_STEP_MS + DISSOLVE_MS + 100);
}

// Back returns one step. The question it returns to is un-answered: the groups
// that answer added dissolve, and the groups it removed come back with the rise.
function goBack() {
  if (step === 0 || dissolving) return;
  const to = step - 1;
  show(to);
  const question = questionOf(questions[to]);
  if (!answered.has(question)) return;
  const before = new Set((snapshots.get(question)?.cards ?? []).map((group) => group.id));
  const added = [...$("groups").children]
    .filter((item) => item.dataset.id && !before.has(item.dataset.id));
  snap(added, () => unanswer(to, before));
}

// Drops the answers from a question index on, so the summary falls back to what came before.
function unanswer(index, before) {
  const base = defaults();
  for (const node of questions.slice(index)) {
    const key = questionOf(node);
    answered.delete(key);
    answers = setupFor({ ...answers, [key]: base[key] });
  }
  // The last answer left is the one before the question just un-answered.
  const earlier = index > 0 ? snapshots.get(questionOf(questions[index - 1])) : undefined;
  baseline = earlier ?? emptyState();
  for (const [key, entry] of tagHistory) if (entry.answer >= index) tagHistory.delete(key);
  lastAnswer = index - 1;
  shown = shown.filter((group) => before.has(group.id));
  render();
}

// Back to the empty start: no answers picked, question 1, files closed, default hue.
function reset() {
  answers = defaults();
  answered.clear();
  snapshots.clear();
  baseline = emptyState();
  tagHistory.clear();
  lastAnswer = -1;
  shown = [];
  fileChange = null;
  selected = "CLAUDE.md";
  setFilesView(false);
  show(0);
  render();
}

for (const key of document.querySelectorAll(".k[data-q]")) {
  key.addEventListener("click", () => pick(key));
}
$("switch").addEventListener("click", (event) => {
  const opt = event.target.closest(".seg-opt");
  if (opt) setFilesView(opt.dataset.view === "files");
});
$("back").addEventListener("click", goBack);
$("edit").addEventListener("click", () => snap([...$("groups").children], reset));
$("copy").addEventListener("click", copyCommand);
document.addEventListener("keydown", pickByDigit);
buildSteps();
render();

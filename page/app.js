// The page's state and controls. The engine's own model holds the answers,
// so the page and /bindwright:setup always start from the same defaults.
import { defaults } from "../engine/model.js";
import { repoFiles, byFolder } from "./files.js";
import { summarize } from "./summary.js";
import { encodeSetupCode } from "../engine/setupcode.js";

// One accent hue per setup (docs/v2/DESIGN.md).
const HUES = { "false,false": 150, "true,false": 200, "false,true": 70, "true,true": 340 };
const hueFor = (team, client) => HUES[`${team},${client}`];
const $ = (id) => document.getElementById(id);
const questions = [...document.querySelectorAll(".q")];
const questionOf = (node) => node.querySelector("[data-q]").dataset.q;
const VIEWS = { questions: $("ask"), composing: $("composing"), result: $("result") };
const ADVANCE_MS = 350;
const RISE_STEP_MS = 90;
const TALLY_MS = 500;
const COMPOSE_MS = 4200;
const TICK_MS = 90;
const TICKER_ROWS = 5;
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
// The files the answers build, as [path, text] pairs.
let files = [];
let selected = "CLAUDE.md";
// The question index on screen.
let step = 0;
// The stage view on screen: "questions", "composing" or "result".
let view = "questions";
// Set while the page composes, so answers and dots wait for it.
let busy = false;
// The tally on screen, counting toward the summary's numbers.
let tally = { parts: 0, rules: 0 };
let tallyFrame = 0;

// The engine's defaults for these answers. Private is the engine's isPrivate
// argument, so it is passed on under that name.
function setupFor(parts) {
  return defaults({ team: parts.team, client: parts.client, isPrivate: parts.private });
}

// Records an answer. A new setup starts from that setup's defaults, as setup itself does.
function choose(question, value) {
  answered.add(question);
  if (answers[question] !== value) answers = setupFor({ ...answers, [question]: value });
  render();
}

// Answers from a key, then moves on after a short pause. Answering the last
// question composes the setup.
function pick(key) {
  if (busy || view !== "questions") return;
  const from = questions.indexOf(key.closest(".q"));
  choose(key.dataset.q, key.dataset.v === "true");
  setTimeout(() => advance(from), ADVANCE_MS);
}

// After a pick: the last question composes, any other moves to the next question
// unless the reader has already moved on.
function advance(from) {
  if (from === questions.length - 1) compose();
  else if (step === from) show(from + 1);
}

// Keys 1 and 2 pick that answer of the current question, unless a text field has focus.
function pickByDigit(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest("input, textarea, select, [contenteditable]")) return;
  const keys = questions[step]?.querySelectorAll(".k") ?? [];
  const key = keys[Number(event.key) - 1];
  if (key) pick(key);
}

// Shows a question. Keyboard focus on the step being left moves to the new step's heading.
function show(next) {
  const leaving = $("stage").contains(document.activeElement);
  step = next;
  paintStage();
  if (leaving) stageHeading().focus({ preventScroll: true });
}

function stageHeading() {
  return questions[step].querySelector("h3");
}

// Hides a node but keeps its room (the "off" class), so nothing around it moves.
// A stage step that comes back rises in again.
function setShown(node, visible) {
  if (visible && node.classList.contains("off") && node.closest(".stage")) restart(node, "rise-in");
  node.classList.toggle("off", !visible);
}

function paintStage() {
  questions.forEach((node, i) => setShown(node, i === step));
  setShown($("back"), step > 0);
  paintDots();
}

// A dot is lit when its question is answered. The current question's dot keeps a
// ring. Only lit dots and the current one can be pressed.
function paintDots() {
  [...$("steps").children].forEach((item, i) => {
    const dot = item.firstElementChild;
    const lit = answered.has(questionOf(questions[i]));
    const current = i === step;
    dot.classList.toggle("lit", lit);
    dot.disabled = !lit && !current;
    if (current) dot.setAttribute("aria-current", "step");
    else dot.removeAttribute("aria-current");
  });
}

// One progress dot per question.
function buildSteps() {
  const dots = questions.map((_, i) => {
    const dot = el("button", { className: "dot", type: "button" });
    dot.dataset.step = i;
    dot.setAttribute("aria-label", `Question ${i + 1}`);
    return el("li", {}, dot);
  });
  $("steps").replaceChildren(...dots);
}

function commandLine() {
  return `/bindwright:setup ${encodeSetupCode(answers)}`;
}

const COPY_FEEDBACK_MS = 1500;
const copyResetTimers = new WeakMap();

// Shows a copy result on its icon button: a check mark when copied, or a
// hint to copy by hand when the clipboard refused.
function showCopyResult(button, copied) {
  clearTimeout(copyResetTimers.get(button));
  button.classList.toggle("copied", copied);
  button.setAttribute("aria-label", copied ? "Copied" : "Select and copy");
  if (copied) restart(button, "pulse");
  copyResetTimers.set(button, setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", "Copy command");
  }, COPY_FEEDBACK_MS));
}

// Selects the code's text so the reader can copy it by hand.
function selectCodeText(code) {
  const range = document.createRange();
  range.selectNodeContents(code);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Copies text for a command box, then reports the result on its button.
async function copyBoxText(button, code, text) {
  try {
    await navigator.clipboard.writeText(text);
    showCopyResult(button, true);
  } catch {
    selectCodeText(code);
    showCopyResult(button, false);
  }
}

function copyCommand() {
  return copyBoxText($("copy"), $("cmd-text"), commandLine());
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
  paintStage();
}

// Shows one of the three stage views. The view leaving fades out and the one
// coming in fades up; under reduced motion the change is at once.
function showView(name) {
  if (name === view) return;
  const from = VIEWS[view];
  const to = VIEWS[name];
  const keepFocus = from.contains(document.activeElement);
  from.classList.add(still() ? "off" : "leave");
  to.classList.remove("off", "leave");
  restart(to, "arrive");
  view = name;
  if (keepFocus) headingOf(name).focus({ preventScroll: true });
}

function headingOf(name) {
  return name === "questions" ? stageHeading() : VIEWS[name].querySelector("h3");
}

// Builds the setup from the answers: plays the composing view, then shows the results.
async function compose() {
  if (busy) return;
  busy = true;
  showView("composing");
  try {
    files = await repoFiles(answers);
    if (!still()) await playCompose(summarize(files, answers));
    showResults();
  } catch (err) {
    showFailure(err);
  }
  busy = false;
}

// What the composing view says while it builds each group.
const COMPOSE_WORDS = {
  rules: "Writing your rules",
  reviews: "Setting up pull request reviews",
  guards: "Adding safety guards",
  sessions: "Adding session routines",
  checks: "Adding code checks",
  issues: "Adding issue forms",
  project: "Preparing your project files",
  notes: "Saving your answers",
};

// Types one line per group, fills the bar and ticks the file paths by, for COMPOSE_MS.
function playCompose(groups) {
  const gap = COMPOSE_MS / (groups.length + 1);
  $("compose-lines").replaceChildren(...groups.map((group, i) => {
    const line = el("li", { textContent: COMPOSE_WORDS[group.id] ?? `Adding ${group.title.toLowerCase()}` });
    line.style.setProperty("--delay", `${Math.round(i * gap)}ms`);
    return line;
  }));
  const bar = $("compose-bar");
  bar.style.animationDuration = `${COMPOSE_MS}ms`;
  restart(bar, "fill");
  const ticker = startTicker(files.map(([path]) => path), $("compose-files"));
  return new Promise((resolve) => {
    setTimeout(() => { clearInterval(ticker); resolve(); }, COMPOSE_MS);
  });
}

// Shows a window of the paths in the list and moves the window on every tick.
function startTicker(paths, list) {
  if (!paths.length) return 0;
  let first = 0;
  const paint = () => {
    [...list.children].forEach((item, k) => {
      item.textContent = paths[(first + k) % paths.length];
    });
    first++;
  };
  list.replaceChildren(...Array.from({ length: TICKER_ROWS }, () => el("li")));
  paint();
  return setInterval(paint, TICK_MS);
}

// Draws the summary and the file tree for the answers, then shows the results view.
function showResults() {
  if (!files.some(([path]) => path === selected)) selected = files[0]?.[0];
  drawGroups();
  drawTree();
  drawFile();
  $("cmd-text").textContent = commandLine();
  showView("result");
  $("status").textContent = "What you get is updated.";
}

function showFailure(err) {
  const fail = el("li", {
    textContent: `This part of the page could not load (${err.message || err}). `
      + "Reload the page to try again.",
  });
  $("groups").replaceChildren(fail);
  showView("result");
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// The summary cards. Each card rises in turn, and its rules always show.
function drawGroups() {
  const groups = summarize(files, answers);
  $("groups").replaceChildren(...groups.map((group, i) => groupCard(group, i)));
  countTally(groups);
  setFilesView(filesOpen());
}

function groupCard(group, index) {
  const item = el("li", { className: "enter" },
    el("b", { textContent: group.title }), el("p", { textContent: group.say }));
  item.style.animationDelay = `${index * RISE_STEP_MS}ms`;
  if (group.facts.length) item.append(factsList(group));
  if (group.rules) {
    item.classList.add("has-rules");
    item.append(rulesList(group.rules));
  }
  return item;
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

// The card's detail lines.
function factsList(group) {
  return el("ul", { className: "facts" },
    ...group.facts.map((fact) => el("li", { textContent: fact.text })));
}

// The rules card's rows, one per rule file.
function rulesList(rules) {
  return el("ul", { className: "rules" }, ...rules.map(([name, line], i) => {
    const row = el("li", {}, el("b", { textContent: name }), ` ${line}`);
    row.style.setProperty("--i", i);
    return row;
  }));
}

// Folder rows wherever a path enters a new folder, then the file itself.
function drawTree() {
  const rows = [];
  let open = [];
  const paths = files.map(([path]) => path).sort(byFolder);
  for (const path of paths) {
    const parts = path.split("/");
    const dirs = parts.slice(0, -1);
    let same = 0;
    while (same < dirs.length && open[same] === dirs[same]) same++;
    for (let d = same; d < dirs.length; d++) rows.push(row("div", "dir", d, `${dirs[d]}/`));
    open = dirs;
    rows.push(fileRow(path, dirs.length, parts.at(-1)));
  }
  $("tree").replaceChildren(...rows);
}

function fileRow(path, depth, name) {
  const file = row("button", "file", depth, name);
  file.type = "button";
  file.dataset.path = path;
  if (path === selected) file.setAttribute("aria-current", "true");
  return file;
}

function row(tag, kind, depth, text) {
  const node = el(tag, { className: kind, textContent: text });
  node.style.setProperty("--d", depth);
  return node;
}

function drawFile() {
  const file = files.find(([path]) => path === selected);
  $("path").textContent = file ? file[0] : "";
  $("code").textContent = file ? file[1] : "";
  $("code").scrollTop = 0;
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
  const mode = open ? "files" : "overview";
  const panel = $("files");
  const groups = $("groups");
  if (panel.classList.contains("away") === open) {
    const [leaving, arriving] = open ? [groups, panel] : [panel, groups];
    leaving.classList.remove("arrive");
    leaving.classList.add("away", "leave");
    arriving.classList.remove("away", "leave");
    arriving.classList.add("arrive");
  }
  $("switch").dataset.view = mode;
  for (const opt of $("switch").querySelectorAll(".seg-opt")) {
    opt.setAttribute("aria-pressed", String(opt.dataset.view === mode));
  }
  $("files-opt").textContent = `Files · ${files.length}`;
}

// Back returns one question. Nothing is un-answered.
function goBack() {
  if (step === 0 || busy) return;
  show(step - 1);
}

// Shows the last question with the answers kept, so re-answering it composes again.
function editAnswers() {
  if (busy) return;
  show(questions.length - 1);
  showView("questions");
}

// Back to the empty start: no answers picked, question 1, Overview, default hue.
function startOver() {
  if (busy) return;
  answers = defaults();
  answered.clear();
  tally = { parts: 0, rules: 0 };
  cancelAnimationFrame(tallyFrame);
  selected = "CLAUDE.md";
  setFilesView(false);
  show(0);
  paintTally();
  showView("questions");
  render();
}

for (const key of document.querySelectorAll(".k[data-q]")) {
  key.addEventListener("click", () => pick(key));
}
$("steps").addEventListener("click", (event) => {
  const dot = event.target.closest(".dot");
  if (dot && !busy) show(Number(dot.dataset.step));
});
$("switch").addEventListener("click", (event) => {
  const opt = event.target.closest(".seg-opt");
  if (opt) setFilesView(opt.dataset.view === "files");
});
$("back").addEventListener("click", goBack);
$("edit").addEventListener("click", editAnswers);
$("restart").addEventListener("click", startOver);
// Each install command has its own icon copy button inside its box.
function copyInstallLine(event) {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const code = button.parentElement.querySelector("code");
  copyBoxText(button, code, code.textContent);
}

$("copy").addEventListener("click", copyCommand);
$("command").addEventListener("click", copyInstallLine);
document.addEventListener("keydown", pickByDigit);
buildSteps();
render();

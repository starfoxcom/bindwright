// The result view: the setup the engine writes for the default answers, with its
// summary, file tree and file preview. /bindwright:setup asks the real questions;
// the page shows one person's own public project with every extra on.
import { defaults } from "../engine/model.js";
import { repoFiles, byFolder } from "./files.js";
import { summarize } from "./summary.js";
import { t } from "./i18n/index.js";

const $ = (id) => document.getElementById(id);
const answers = defaults();
const RISE_STEP_MS = 90;
const TALLY_MS = 500;
const COPY_FEEDBACK_MS = 1500;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const mix = (from, to, share) => Math.round(from + (to - from) * share);
const ruleCount = (groups) => groups.reduce((sum, group) => sum + (group.rules?.length ?? 0), 0);
const filesOpen = () => !$("files").classList.contains("away");
// Where the file list and the open file share the width, side by side.
const sideBySide = matchMedia("(min-width: 901px)");

// Restarts the one-shot CSS animation that the named class sets on the node.
function restart(node, name) {
  if (still()) return;
  node.classList.remove(name);
  void node.offsetWidth;
  node.classList.add(name);
}

// The files the answers build, as [path, text] pairs.
let files = [];
let selected = "CLAUDE.md";
// The folders closed in the file list, by path.
let closed = new Set();
// The tally on screen, counting toward the summary's numbers.
let tally = { parts: 0, rules: 0 };
let tallyFrame = 0;

const copyResetTimers = new WeakMap();

// Shows a copy result on its icon button: a check mark when copied, or a
// hint to copy by hand when the clipboard refused.
function showCopyResult(button, copied) {
  clearTimeout(copyResetTimers.get(button));
  button.classList.toggle("copied", copied);
  button.setAttribute("aria-label", t(copied ? "copy.done" : "copy.manual"));
  if (copied) restart(button, "pulse");
  copyResetTimers.set(button, setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", t("copy.command"));
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

// Copies text for an install box, then reports the result on its button.
async function copyBoxText(button, code, text) {
  try {
    await navigator.clipboard.writeText(text);
    showCopyResult(button, true);
  } catch {
    selectCodeText(code);
    showCopyResult(button, false);
  }
}

// Each install command has its own icon copy button inside its box.
function copyInstallLine(event) {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const code = button.parentElement.querySelector("code");
  copyBoxText(button, code, code.textContent);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Draws the summary cards, the tally and the view switch from the files.
function drawGroups() {
  const groups = summarize(files, answers);
  $("groups").replaceChildren(...groups.map((group, i) => groupCard(group, i)));
  countTally(groups);
  setFilesView(filesOpen());
}

// The summary card. Each card rises in turn, and its rules always show.
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
    const share = still() ? 1 : Math.min(Math.max(now - start, 0) / TALLY_MS, 1);
    tally = { parts: mix(from.parts, to.parts, share), rules: mix(from.rules, to.rules, share) };
    paintTally();
    if (share < 1) tallyFrame = requestAnimationFrame(frame);
  };
  frame(start);
}

// "· 6 parts, 23 rules" after the heading.
function paintTally() {
  const { parts, rules } = tally;
  $("tally").textContent = t("tally", {
    parts: t("tally.parts", { count: parts }),
    rules: t("tally.rules", { count: rules }),
  });
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
// Side by side every folder starts open; on a narrow screen every one starts closed.
function drawTree() {
  const rows = [];
  let open = [];
  const paths = files.map(([path]) => path).sort(byFolder);
  for (const path of paths) {
    const parts = path.split("/");
    const dirs = parts.slice(0, -1);
    let same = 0;
    while (same < dirs.length && open[same] === dirs[same]) same++;
    for (let d = same; d < dirs.length; d++) rows.push(row("dir", dirs.slice(0, d + 1).join("/"), `${dirs[d]}/`));
    open = dirs;
    const file = row("file", path, parts.at(-1));
    if (path === selected) file.setAttribute("aria-current", "true");
    rows.push(file);
  }
  const folders = rows.filter((r) => r.classList.contains("dir")).map((r) => r.dataset.path);
  closed = new Set(sideBySide.matches ? [] : folders);
  $("tree").replaceChildren(...rows);
  paintFolders();
}

// A folder or file row, indented by its depth.
function row(kind, path, text) {
  const node = el("button", { type: "button", className: kind, textContent: text });
  node.dataset.path = path;
  node.style.setProperty("--d", path.split("/").length - 1);
  return node;
}

// Hides the rows inside closed folders and marks each folder open or closed.
function paintFolders() {
  for (const node of $("tree").children) {
    const folders = node.dataset.path.split("/").slice(0, -1);
    node.hidden = folders.some((_, i) => closed.has(folders.slice(0, i + 1).join("/")));
    if (node.classList.contains("dir")) node.setAttribute("aria-expanded", String(!closed.has(node.dataset.path)));
  }
}

function drawFile() {
  const file = files.find(([path]) => path === selected);
  $("path").textContent = file ? file[0] : "";
  $("code").textContent = file ? file[1] : "";
  $("code").scrollTop = 0;
}

function selectFile(file) {
  selected = file.dataset.path;
  for (const node of $("tree").querySelectorAll(".file")) {
    if (node === file) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
  drawFile();
  restart($("code").parentElement, "swap");
}

// On a narrow screen the list and the open file take turns: tapping a file
// opens it full width, and "All files" returns to the list at that file.
function setReading(reading) {
  const panel = $("files");
  if (panel.classList.contains("reading") === reading) return;
  panel.classList.toggle("reading", reading);
  const shown = reading ? $("code").parentElement : $("tree");
  restart(shown, "swap");
  const target = reading ? panel : $("tree").querySelector('.file[aria-current="true"]');
  target?.scrollIntoView({ block: reading ? "start" : "center", behavior: still() ? "auto" : "smooth" });
  (reading ? $("back-files") : target)?.focus({ preventScroll: true });
}

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
  if (open) panel.classList.remove("reading");
  $("switch").dataset.view = mode;
  for (const opt of $("switch").querySelectorAll(".seg-opt")) {
    opt.setAttribute("aria-pressed", String(opt.dataset.view === mode));
  }
  $("files-opt").textContent = t("files.count", { count: files.length });
}

// Fetches the files for the default answers, then draws the results. A failed
// fetch shows its message in place of the summary.
async function loadResults() {
  try {
    files = await repoFiles(answers);
  } catch (err) {
    $("groups").replaceChildren(el("li", { textContent: t("failure", { error: err.message || err }) }));
    return;
  }
  if (!files.some(([path]) => path === selected)) selected = files[0]?.[0];
  drawGroups();
  drawTree();
  drawFile();
}

$("tree").addEventListener("click", (event) => {
  const folder = event.target.closest(".dir");
  if (folder) {
    const path = folder.dataset.path;
    if (!closed.delete(path)) closed.add(path);
    paintFolders();
    return;
  }
  const file = event.target.closest(".file");
  if (!file) return;
  if (file.dataset.path !== selected) selectFile(file);
  if (!sideBySide.matches) setReading(true);
});
$("switch").addEventListener("click", (event) => {
  const opt = event.target.closest(".seg-opt");
  if (opt) setFilesView(opt.dataset.view === "files");
});
$("back-files").addEventListener("click", () => setReading(false));
$("install").addEventListener("click", copyInstallLine);
loadResults();

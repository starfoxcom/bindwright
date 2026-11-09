// The file browser: the setup the engine writes for the default answers, as a
// file tree and a file preview behind one button. /bindwright:setup asks the
// real questions; the page shows one person's own public project with every extra on.
import { defaults } from "../engine/model.js";
import { repoFiles, byFolder } from "./files.js";
import { t } from "./i18n/index.js";
import { currentView, setView } from "./view.js";

const $ = (id) => document.getElementById(id);
const answers = defaults();
const COPY_FEEDBACK_MS = 1500;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
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

// The install switch: Claude Code CLI or the desktop app, each tab showing its own steps.
// It follows the page's view (view.js), and picking a tab switches the view too.
const installTabs = [$("install-tab-cli"), $("install-tab-desktop")];
const installTabFor = (view) => installTabs[view === "terminal" ? 0 : 1];

function showInstallTab(tab) {
  for (const each of installTabs) {
    const isPicked = each === tab;
    each.setAttribute("aria-selected", String(isPicked));
    each.tabIndex = isPicked ? 0 : -1;
    $(each.getAttribute("aria-controls")).hidden = !isPicked;
  }
  tab.parentElement.dataset.active = tab === installTabs[0] ? "cli" : "desktop";
}

function pickInstallTab(tab) {
  showInstallTab(tab);
  setView(tab === installTabs[0] ? "terminal" : "desktop");
}

// Arrow keys move between the two tabs, as a tab list expects.
function onInstallTabKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const other = installTabs.find((tab) => tab !== event.currentTarget);
  pickInstallTab(other);
  other.focus();
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
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

// The button names what a press does: the file count while closed, hiding while open.
function paintBrowse(open) {
  $("browse").setAttribute("aria-expanded", String(open));
  $("browse").textContent = open ? t("files.hide") : t("files.browse", { count: files.length });
}

// Shows or hides the file browser under the scene. Opening plays its arrival
// and brings it into view.
function setBrowse(open) {
  const panel = $("files");
  panel.hidden = !open;
  paintBrowse(open);
  if (!open) return;
  restart(panel, "arrive");
  panel.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });
}

// Fetches the files for the default answers, then draws the browser. A failed
// fetch replaces the button with its message.
async function loadResults() {
  try {
    files = await repoFiles(answers);
  } catch (err) {
    const message = t("failure", { error: err.message || err });
    $("browse").replaceWith(el("p", { className: "preview-note", textContent: message }));
    return;
  }
  if (!files.some(([path]) => path === selected)) selected = files[0]?.[0];
  drawTree();
  drawFile();
  paintBrowse(!$("files").hidden);
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
$("browse").addEventListener("click", () => setBrowse($("files").hidden));
$("back-files").addEventListener("click", () => setReading(false));
$("install").addEventListener("click", copyInstallLine);
showInstallTab(installTabFor(currentView()));
document.addEventListener("viewchange", () => showInstallTab(installTabFor(currentView())));
for (const tab of installTabs) {
  tab.addEventListener("click", () => pickInstallTab(tab));
  tab.addEventListener("keydown", onInstallTabKey);
}
loadResults();

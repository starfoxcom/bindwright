// The "what lands where" scene: /bindwright:setup runs in a small terminal, and each file
// it sets up flies into the box it belongs to, this computer or this project.
import { t } from "./i18n/index.js";
import { computer, project } from "./lands-data.js";
import { createTerminal } from "./terminal.js";

// The Write line shows for this long, then its row lands; a row pauses before the next.
const TOOL_MS = 350;
const ROW_PAUSE_MS = 250;

const term = createTerminal(document.getElementById("lands-stage"));
const computerList = document.getElementById("lands-computer");
const projectList = document.getElementById("lands-project");
// Each list keeps room for all its rows, so the boxes do not grow as rows land.
computerList.style.setProperty("--rows", computer.length);
projectList.style.setProperty("--rows", project.length);

function el(tag, cls, text = "") {
  return Object.assign(document.createElement(tag), { className: cls, textContent: text });
}

// One row in a box: what the item is, and the path it writes.
function row({ key, path }) {
  const item = el("li", "row");
  item.append(el("b", "row-label", t(`lands.item.${key}`)), el("code", "row-path", path));
  return item;
}

// Each file gets its Write line, then its row flies into the box.
async function land(list, entries) {
  for (const entry of entries) {
    await term.tool("Write", entry.path, TOOL_MS);
    list.append(row(entry));
    await term.wait(ROW_PAUSE_MS);
  }
}

async function story() {
  term.reset();
  computerList.replaceChildren();
  projectList.replaceChildren();
  await term.type("/bindwright:setup");
  await term.think(t("lands.verb"), 1600, 1.4);
  term.say(t("lands.say.first"));
  term.gap();
  await term.wait(1200);
  await land(computerList, computer);
  await term.wait(1000);
  await land(projectList, project);
  term.gap();
  term.say(t("lands.say.done"));
  await term.wait(6000);
}

term.play(story);

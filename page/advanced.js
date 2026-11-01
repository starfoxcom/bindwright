// The "More settings" drawer: one switch per advanced answer, and the Share
// button that copies the link to the current answers.
import { t } from "./i18n/index.js";
import { SWITCHES, hashFor } from "./link.js";
import { writeClipboard } from "./copy.js";
import { el, restart } from "./dom.js";

const SHARE_FEEDBACK_MS = 1500;
const $ = (id) => document.getElementById(id);
// The switch rows on screen: { key, needs, button }.
let rows = [];
// The page's answers and the setter the drawer calls: { getAnswers, setAdvanced }.
let source = null;
let shareLabel = "";
let shareTimer = 0;

// Builds the switch rows, wires the drawer and the Share button, and paints the switches.
export function setupAdvanced(options) {
  source = options;
  rows = SWITCHES.map(buildRow);
  $("switches").replaceChildren(...rows.map((row) => el("li", {}, row.button)));
  shareLabel = $("share").textContent;
  wireDrawer();
  $("share").addEventListener("click", shareLink);
  paintSwitches();
}

// One switch: a label, a hint and the track-and-knob drawn by CSS.
function buildRow({ key, needs }) {
  const button = el("button", { type: "button", className: "sw" },
    el("span", { className: "sw-label", textContent: t(`switch.${key}.label`) }),
    el("span", { className: "sw-hint", textContent: t(`switch.${key}.hint`) }));
  button.setAttribute("role", "switch");
  button.addEventListener("click", () => flip(key));
  return { key, needs, button };
}

function flip(key) {
  source.setAdvanced(key, !source.getAnswers().advanced[key]);
  paintSwitches();
}

// Repaints every switch from the answers. A switch whose needed switch is off is disabled.
export function paintSwitches() {
  const { advanced } = source.getAnswers();
  for (const { key, needs, button } of rows) {
    const blocked = Boolean(needs) && !advanced[needs];
    button.setAttribute("aria-checked", String(advanced[key]));
    button.setAttribute("aria-disabled", String(blocked));
    button.disabled = blocked;
  }
}

function wireDrawer() {
  const drawer = $("drawer");
  $("more").addEventListener("click", () => drawer.showModal());
  $("drawer-done").addEventListener("click", () => drawer.close());
  drawer.addEventListener("click", (event) => {
    if (event.target === drawer && isOutside(event, drawer)) drawer.close();
  });
}

// A click on the dialog's own box lands on the dialog, so the backdrop is the
// part of the page outside its box.
function isOutside(event, node) {
  const box = node.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right
    || event.clientY < box.top || event.clientY > box.bottom;
}

// Copies the link to the current answers and shows that it was copied.
async function shareLink() {
  const button = $("share");
  const link = location.origin + location.pathname + hashFor(source.getAnswers());
  if (!await writeClipboard(link)) return;
  clearTimeout(shareTimer);
  button.textContent = t("share.done");
  restart(button, "pulse");
  $("status").textContent = t("share.done");
  shareTimer = setTimeout(() => { button.textContent = shareLabel; }, SHARE_FEEDBACK_MS);
}

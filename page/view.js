// Which Claude Code the page's scenes show: the desktop app (the default) or the terminal.
// The choice lives on <html data-view>, set before the page paints by the inline script in
// its head, and is remembered in this browser. Every drawn scene replays in the view picked.

const KEY = "bindwright.view";
const VIEWS = ["desktop", "terminal"];

export const currentView = () => document.documentElement.dataset.view;

// Shows every scene in `view`, remembers it, and tells the scenes and switches to follow.
export function setView(view) {
  if (!VIEWS.includes(view) || view === currentView()) return;
  document.documentElement.dataset.view = view;
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // Storage refused (a private window): the choice lasts until the page closes.
  }
  document.dispatchEvent(new CustomEvent("viewchange", { detail: view }));
}

// The floating switch: one radio per view, the picked one under the sliding thumb.
function syncSwitch(group) {
  group.dataset.active = currentView();
  for (const button of group.querySelectorAll("[data-pick]")) {
    const isPicked = button.dataset.pick === currentView();
    button.setAttribute("aria-checked", String(isPicked));
    button.tabIndex = isPicked ? 0 : -1;
  }
}

function onSwitchKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const other = VIEWS.find((view) => view !== currentView());
  setView(other);
  event.currentTarget.parentElement.querySelector(`[data-pick="${other}"]`).focus();
}

const group = document.getElementById("view-switch");
if (group) {
  for (const button of group.querySelectorAll("[data-pick]")) {
    button.addEventListener("click", () => setView(button.dataset.pick));
    button.addEventListener("keydown", onSwitchKey);
  }
  syncSwitch(group);
  document.addEventListener("viewchange", () => syncSwitch(group));
}

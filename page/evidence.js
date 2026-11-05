// The evidence section's counts, all from the projects whose owners chose to share them:
// the three totals count up once and a bar per project grows with its reviewed pull
// requests, split by whether the review passed or caught a problem. The counts stay
// hidden until the counter answers with at least one project. Each animation starts as
// its block enters the view, while it fades in; reduced motion shows the final state.
import { t } from "./i18n/index.js";
import { shared } from "./community.js";
import { ENTER_MARGIN } from "./reveal.js";
import { PARTS, el, projectRow } from "./bars.js";

const counts = document.getElementById("evidence-counts");
const note = document.getElementById("evidence-note");
const stats = counts.querySelector(".stats");
const chart = document.getElementById("projects");
const legend = document.getElementById("legend");
const DURATION_MS = 1200;
const STEP_MS = 30;
const steps = DURATION_MS / STEP_MS;

// Ease-out: quick at first, then slowing into the final number.
const easeOut = (p) => 1 - (1 - p) ** 3;

// Counts one number from zero up to its data-count target.
function countUp(node) {
  const target = Number(node.dataset.count);
  let step = 0;
  const tick = () => {
    step += 1;
    node.textContent = String(Math.round(target * easeOut(step / steps)));
    if (step < steps) setTimeout(tick, STEP_MS);
  };
  node.textContent = "0";
  setTimeout(tick, STEP_MS);
}

function legendItem(part) {
  const item = el("li", "legend-item");
  item.append(el("i", `swatch ${part.cls}`), t(part.key));
  return item;
}

/** Runs `start` once, when `node` enters the view: the moment reveal.js fades it in. */
export function onEnter(node, start) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    start();
  }, { rootMargin: ENTER_MARGIN });
  observer.observe(node);
}

function show(total) {
  for (const name of ["reviewed", "fixed", "deep"]) {
    const node = stats.querySelector(`[data-total="${name}"]`);
    node.dataset.count = String(total[name]);
    node.textContent = String(total[name]);
  }
  note.textContent = t("evidence.note", { count: total.projects });
  const largest = Math.max(...total.rows.map((row) => row.reviewed));
  chart.replaceChildren(...total.rows.map((row, index) => projectRow(row, index, largest)));
  legend.replaceChildren(...PARTS.map(legendItem));
  counts.hidden = false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    chart.classList.add("counted");
    return;
  }
  onEnter(stats, () => stats.querySelectorAll("[data-count]").forEach(countUp));
  onEnter(chart, () => chart.classList.add("counted"));
}

shared.then((total) => total && show(total)).catch(() => {});

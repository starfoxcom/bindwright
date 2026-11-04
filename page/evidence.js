// The evidence section: the three totals count up once, and a bar per project grows
// with its reviewed pull requests, split by whether the review passed or caught a
// problem. Projects people shared anonymously join the same chart and totals before
// anything moves. Each starts as its own block enters the view, while it fades in.
// Reduced motion shows the final state.
import { t } from "./i18n/index.js";
import { projects } from "./evidence-data.js";
import { shared } from "./community.js";
import { ENTER_MARGIN } from "./reveal.js";
import { PARTS, el, projectRow } from "./bars.js";

const stats = document.querySelector("#evidence .stats");
const note = document.getElementById("evidence-note");
const chart = document.getElementById("projects");
const legend = document.getElementById("legend");
const DURATION_MS = 1200;
const STEP_MS = 30;
const steps = DURATION_MS / STEP_MS;

const own = projects.map((project) => ({ ...project, label: t(`evidence.project.${project.name}`) }));

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

function drawRows(rows) {
  const largest = Math.max(...rows.map((row) => row.reviewed));
  chart.replaceChildren(...rows.map((row, index) => projectRow(row, index, largest)));
}

// Adds the shared projects' counts to the totals, the note and the chart, largest first.
function addShared(counts) {
  for (const name of ["reviewed", "fixed", "deep"]) {
    const node = stats.querySelector(`[data-total="${name}"]`);
    const total = Number(node.dataset.count) + counts[name];
    node.dataset.count = String(total);
    node.textContent = String(total);
  }
  note.textContent = t("evidence.note.shared", { count: own.length + counts.projects, shared: counts.projects });
  drawRows([...own, ...counts.rows].sort((a, b) => b.reviewed - a.reviewed));
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

// Drawn on load, so the rows exist before the animation runs; the shared ones join once
// the counter answers, and the animations wait for that.
drawRows(own);
legend.replaceChildren(...PARTS.map(legendItem));
const ready = shared.then((counts) => counts && addShared(counts)).catch(() => {});
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  chart.classList.add("counted");
} else {
  onEnter(stats, () => ready.then(() => stats.querySelectorAll("[data-count]").forEach(countUp)));
  onEnter(chart, () => ready.then(() => chart.classList.add("counted")));
}

// The evidence section: the three totals count up once, and a bar per project grows
// with its reviewed pull requests, split by whether the review passed or caught a
// problem. Each starts as its own block enters the view, while it fades in. Reduced motion
// shows the final state.
import { t } from "./i18n/index.js";
import { projects } from "./evidence-data.js";
import { ENTER_MARGIN } from "./reveal.js";
import { PARTS, el, projectRow } from "./bars.js";

const stats = document.querySelector("#evidence .stats");
const chart = document.getElementById("projects");
const legend = document.getElementById("legend");
const DURATION_MS = 1200;
const STEP_MS = 30;
const steps = DURATION_MS / STEP_MS;

const largest = Math.max(...projects.map((project) => project.reviewed));

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

// Drawn on load, so the rows exist before the animation runs.
function draw() {
  const labelled = projects.map((project) => ({ ...project, label: t(`evidence.project.${project.name}`) }));
  chart.replaceChildren(...labelled.map((project, index) => projectRow(project, index, largest)));
  legend.replaceChildren(...PARTS.map(legendItem));
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

draw();
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  chart.classList.add("counted");
} else {
  onEnter(stats, () => stats.querySelectorAll("[data-count]").forEach(countUp));
  onEnter(chart, () => chart.classList.add("counted"));
}

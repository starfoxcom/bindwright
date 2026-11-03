// The evidence section: the three totals count up once, and a bar per project grows
// with its merged pull requests, split by how each one's review went, when the section
// first scrolls into view. Reduced motion shows the final state.
import { t } from "./i18n/index.js";
import { projects } from "./evidence-data.js";

const section = document.getElementById("evidence");
const chart = document.getElementById("projects");
const legend = document.getElementById("legend");
const DURATION_MS = 1200;
const STEP_MS = 30;
const steps = DURATION_MS / STEP_MS;
const locale = document.documentElement.lang;

// The parts of a project's bar, left to right: the colour class, the legend text and
// how many of the project's merged pull requests the part covers.
const PARTS = [
  { cls: "seg-ok", key: "evidence.legend.passed", count: (p) => p.reviewed - p.fixed },
  { cls: "seg-fixed", key: "evidence.legend.fixed", count: (p) => p.fixed },
  { cls: "seg-none", key: "evidence.legend.none", count: (p) => p.merged - p.reviewed },
];
const largest = Math.max(...projects.map((project) => project.merged));

// Ease-out: quick at first, then slowing into the final number.
const easeOut = (p) => 1 - (1 - p) ** 3;

// Counts one number from zero up to its data-count target.
function countUp(node) {
  const target = Number(node.dataset.count);
  let step = 0;
  const tick = () => {
    step += 1;
    node.textContent = Math.round(target * easeOut(step / steps)).toLocaleString(locale);
    if (step < steps) setTimeout(tick, STEP_MS);
  };
  node.textContent = "0";
  setTimeout(tick, STEP_MS);
}

function el(tag, cls, text = "") {
  return Object.assign(document.createElement(tag), { className: cls, textContent: text });
}

const percent = (part, whole) => `${((100 * part) / whole).toFixed(3)}%`;

function segment(part, project) {
  const piece = el("i", part.cls);
  piece.style.width = percent(part.count(project), project.merged);
  return piece;
}

// One project: its name, its bar (as wide as its merged count against the largest), and
// its count. The bar's CSS grows it from the left once the section is counted.
function row(project, index) {
  const item = el("li", "project");
  item.style.setProperty("--row", index);
  const bar = el("i", "project-bar");
  bar.style.width = percent(project.merged, largest);
  bar.append(...PARTS.map((part) => segment(part, project)));
  const track = el("span", "project-track");
  track.append(bar);
  item.append(
    el("span", "project-name", t(`evidence.project.${project.name}`)),
    track,
    el("span", "project-count", t("evidence.prs", { count: project.merged })),
  );
  return item;
}

function legendItem(part) {
  const item = el("li", "legend-item");
  item.append(el("i", `swatch ${part.cls}`), t(part.key));
  return item;
}

// Drawn on load, so the rows exist before the animation runs.
function draw() {
  chart.replaceChildren(...projects.map(row));
  legend.replaceChildren(...PARTS.map(legendItem));
}

function reveal() {
  section.classList.add("counted");
  section.querySelectorAll("[data-count]").forEach(countUp);
}

draw();
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  section.classList.add("counted");
} else {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    reveal();
  }, { threshold: 0.35 });
  observer.observe(section);
}

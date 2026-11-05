// The evidence section's project bars: one row per project, its bar as wide as its
// checked pull requests against the largest, split by how many review rounds they took.
// The share that passed first try is rounded, so it can read 100% with a stalled one left.
import { t } from "./i18n/index.js";

// The parts of a project's bar, left to right: the colour class, the legend text and
// how many of the project's checked pull requests the part covers.
export const PARTS = [
  { cls: "seg-ok", key: "evidence.legend.passed", count: (p) => p.checked - p.caught },
  { cls: "seg-fixed", key: "evidence.legend.fixed", count: (p) => p.caught - p.stalled },
  { cls: "seg-stalled", key: "evidence.legend.stalled", count: (p) => p.stalled },
];

export function el(tag, cls, text = "") {
  return Object.assign(document.createElement(tag), { className: cls, textContent: text });
}

const percent = (part, whole) => `${((100 * part) / whole).toFixed(3)}%`;

function segment(part, project) {
  const piece = el("i", part.cls);
  piece.style.width = percent(part.count(project), project.checked);
  return piece;
}

/**
 * One project's row: `{ label, checked, caught, stalled }` drawn against the `largest`
 * checked count. The bar's CSS grows it from the left once its list gets `counted`.
 */
export function projectRow(project, index, largest) {
  const item = el("li", "project");
  item.style.setProperty("--row", index);
  const bar = el("i", "project-bar");
  bar.style.width = percent(project.checked, largest);
  bar.append(...PARTS.map((part) => segment(part, project)));
  const track = el("span", "project-track");
  track.append(bar);
  item.append(
    el("span", "project-name", project.label),
    track,
    el("span", "project-count", [
      t("evidence.checked", { count: project.checked }),
      t("evidence.firstTry", { percent: Math.round((100 * (project.checked - project.caught)) / project.checked) }),
    ].join(" · ")),
  );
  return item;
}

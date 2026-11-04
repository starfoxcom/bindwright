// The evidence section's project bars, shared by the maintainer's projects and the
// community block: one row per project, its bar as wide as its reviewed pull requests
// against the largest, split by whether the review passed or caught a problem.
import { t } from "./i18n/index.js";

// The parts of a project's bar, left to right: the colour class, the legend text and
// how many of the project's reviewed pull requests the part covers.
export const PARTS = [
  { cls: "seg-ok", key: "evidence.legend.passed", count: (p) => p.reviewed - p.fixed },
  { cls: "seg-fixed", key: "evidence.legend.fixed", count: (p) => p.fixed },
];

export function el(tag, cls, text = "") {
  return Object.assign(document.createElement(tag), { className: cls, textContent: text });
}

const percent = (part, whole) => `${((100 * part) / whole).toFixed(3)}%`;

function segment(part, project) {
  const piece = el("i", part.cls);
  piece.style.width = percent(part.count(project), project.reviewed);
  return piece;
}

/**
 * One project's row: `{ label, reviewed, fixed }` drawn against `largest` reviewed
 * count. The bar's CSS grows it from the left once its list gets the `counted` class.
 */
export function projectRow(project, index, largest) {
  const item = el("li", "project");
  item.style.setProperty("--row", index);
  const bar = el("i", "project-bar");
  bar.style.width = percent(project.reviewed, largest);
  bar.append(...PARTS.map((part) => segment(part, project)));
  const track = el("span", "project-track");
  track.append(bar);
  item.append(
    el("span", "project-name", project.label),
    track,
    el("span", "project-count", [
      t("evidence.checked", { count: project.reviewed }),
      t("evidence.caught", { count: project.fixed }),
    ].join(" · ")),
  );
  return item;
}

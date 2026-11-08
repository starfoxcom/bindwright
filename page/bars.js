// The evidence section's project bars: one row per project, its bar as wide as its
// merged pull requests against the largest, split into the ones that skipped the review
// and, for the rest, how many review rounds they took.
// The share that passed first try is rounded, so it can read 100% with a stalled one left.
import { t } from "./i18n/index.js";

// The parts of a project's bar, left to right: the colour class, the legend text, the
// number's colour and text in the row's breakdown, and how many of the project's merged
// pull requests the part covers.
export const PARTS = [
  { cls: "seg-skipped", key: "evidence.legend.skipped", tone: "stat-info",
    short: "evidence.part.skipped", count: (p) => p.merged - p.checked },
  { cls: "seg-ok", key: "evidence.legend.passed", tone: "stat-accent",
    short: "evidence.part.passed", count: (p) => p.checked - p.caught },
  { cls: "seg-fixed", key: "evidence.legend.fixed", tone: "stat-warn",
    short: "evidence.part.fixed", count: (p) => p.caught - p.stalled },
  { cls: "seg-stalled", key: "evidence.legend.stalled", tone: "stat-red",
    short: "evidence.part.stalled", count: (p) => p.stalled },
];

export function el(tag, cls, text = "") {
  return Object.assign(document.createElement(tag), { className: cls, textContent: text });
}

const percent = (part, whole) => `${((100 * part) / whole).toFixed(3)}%`;

function segment(part, project) {
  const piece = el("i", part.cls);
  piece.style.width = percent(part.count(project), project.merged);
  return piece;
}

// The exact count of each part under the bar, each number in its part's colour.
function breakdown(project) {
  const line = el("span", "project-breakdown");
  line.append(...PARTS.map((part) => {
    const item = el("span", "project-part");
    item.append(el("b", part.tone, String(part.count(project))), ` ${t(part.short)}`);
    return item;
  }));
  return line;
}

/**
 * One project's row: `{ label, merged, checked, caught, stalled }` drawn against the
 * `largest` merged count. The bar's CSS grows it from the left once its list gets `counted`.
 */
export function projectRow(project, index, largest) {
  const item = el("li", "project");
  item.style.setProperty("--row", index);
  const bar = el("i", "project-bar");
  bar.style.width = percent(project.merged, largest);
  bar.append(...PARTS.map((part) => segment(part, project)));
  const track = el("span", "project-track");
  track.append(bar);
  item.append(
    el("span", "project-name", project.label),
    track,
    el("span", "project-count", [
      t("evidence.mergedCount", { count: project.merged }),
      t("evidence.firstTry", { percent: Math.round((100 * (project.checked - project.caught)) / project.checked) }),
    ].join(" · ")),
    breakdown(project),
  );
  return item;
}

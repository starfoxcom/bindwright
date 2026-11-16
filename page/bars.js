// The evidence section's project bars: one row per project, its bar as wide as its
// merged and dropped pull requests against the largest, split into the ones that skipped
// the review, how many review rounds the rest took, the rebuilds of PRs closed at the hard
// stop, and the PRs dropped with no fix or no reason left to exist.
// The share that passed first try is rounded, so it can read 100% with a stalled one left.
import { t } from "./i18n/index.js";

// The parts of a project's bar, left to right: the colour class, the legend text, the
// number's colour and text in the row's breakdown, and how many of the project's merged
// pull requests the part covers.
// A rebuild sits in its own part, so it is taken out of the round bracket it took.
export const PARTS = [
  { cls: "seg-skipped", key: "evidence.legend.skipped", tone: "stat-info",
    short: "evidence.part.skipped", count: (p) => p.merged - p.checked },
  { cls: "seg-ok", key: "evidence.legend.passed", tone: "stat-accent",
    short: "evidence.part.passed", count: (p) => p.checked - p.caught - (p.rebuilt - p.rebuiltCaught) },
  { cls: "seg-fixed", key: "evidence.legend.fixed", tone: "stat-warn",
    short: "evidence.part.fixed",
    count: (p) => p.caught - p.stalled - (p.rebuiltCaught - p.rebuiltStalled) },
  { cls: "seg-stalled", key: "evidence.legend.stalled", tone: "stat-orange",
    short: "evidence.part.stalled", count: (p) => p.stalled - p.rebuiltStalled },
  { cls: "seg-rebuilt", key: "evidence.legend.rebuilt", tone: "stat-purple",
    short: "evidence.part.rebuilt", count: (p) => p.rebuilt - p.rebuiltStalled },
  { cls: "seg-rebuilt-stalled", key: "evidence.legend.rebuiltStalled", tone: "stat-indigo",
    short: "evidence.part.rebuiltStalled", count: (p) => p.rebuiltStalled },
  { cls: "seg-dropped", key: "evidence.legend.dropped", tone: "stat-red",
    short: "evidence.part.dropped", count: (p) => p.dropped },
  { cls: "seg-retired", key: "evidence.legend.retired", tone: "stat-gray",
    short: "evidence.part.retired", count: (p) => p.retired },
];

/** A project's merged and dropped pull requests: the parts of its bar add up to this. */
export const sizeOf = (p) => p.merged + p.dropped + p.retired;

export function el(tag, cls, text = "") {
  return Object.assign(document.createElement(tag), { className: cls, textContent: text });
}

const percent = (part, whole) => `${((100 * part) / whole).toFixed(3)}%`;

function segment(part, project) {
  const piece = el("i", part.cls);
  piece.style.width = percent(part.count(project), sizeOf(project));
  return piece;
}

// The exact count of each part under the bar, each number in its part's colour; an empty
// part other than the first four is left out.
function breakdown(project) {
  const line = el("span", "project-breakdown");
  const shown = PARTS.filter((part, index) => index < 4 || part.count(project) > 0);
  line.append(...shown.map((part) => {
    const item = el("span", "project-part");
    item.append(el("b", part.tone, String(part.count(project))), ` ${t(part.short)}`);
    return item;
  }));
  return line;
}

/**
 * One project's row: `{ label, merged, checked, caught, stalled, rebuilt, rebuiltCaught,
 * rebuiltStalled, dropped, retired }` drawn against the `largest` size (`sizeOf`). The bar's
 * CSS grows it from the left once its list gets `counted`.
 */
export function projectRow(project, index, largest) {
  const item = el("li", "project");
  item.style.setProperty("--row", index);
  const bar = el("i", "project-bar");
  bar.style.width = percent(sizeOf(project), largest);
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

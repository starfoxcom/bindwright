// Anonymous counts from people who chose to share them, read from the counter (counter/
// in the repo) for the evidence chart. Each project shows as its kind only, numbered when
// a kind repeats. `shared` resolves to null while the counter is down, slow or empty.
import { t } from "./i18n/index.js";

const COUNTER = "https://bindwright-counter.starfoxcom.workers.dev/total";
const TIMEOUT_MS = 3000;
const KINDS = ["game", "business-app", "developer-tool", "mobile-app", "website", "other"];

// A preview may read sample totals with ?counter=<url>: any address on a local server,
// otherwise only a file from the page's own site, so a link cannot point the page elsewhere.
function counterUrl() {
  const override = new URLSearchParams(location.search).get("counter");
  if (!override) return COUNTER;
  const url = new URL(override, location.href);
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  return isLocal || url.origin === location.origin ? url.href : COUNTER;
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

// The counter's answer, or null when it is not the shape the chart draws.
function checked(total) {
  const fields = ["projects", "checked", "caught", "deep"];
  if (!total || !fields.every((field) => isCount(total[field])) || !Array.isArray(total.top)) return null;
  const top = total.top.filter((p) => KINDS.includes(p?.kind) && isCount(p.checked) && p.checked > 0
    && isCount(p.caught) && p.caught <= p.checked);
  return { ...total, top };
}

// "Game project", or "Game project 1", "Game project 2" when the kind repeats.
function labelled(top) {
  const totals = {};
  for (const project of top) totals[project.kind] = (totals[project.kind] ?? 0) + 1;
  const seen = {};
  return top.map((project) => {
    seen[project.kind] = (seen[project.kind] ?? 0) + 1;
    const name = t(`evidence.kind.${project.kind}`);
    const label = totals[project.kind] > 1 ? `${name} ${seen[project.kind]}` : name;
    return { label, reviewed: project.checked, fixed: project.caught, isShared: true };
  });
}

async function load() {
  const response = await fetch(counterUrl(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;
  const total = checked(await response.json());
  if (!total || total.projects === 0 || total.top.length === 0) return null;
  return {
    projects: total.projects, reviewed: total.checked, fixed: total.caught, deep: total.deep,
    rows: labelled(total.top),
  };
}

/**
 * The shared totals and top rows, `{ projects, reviewed, fixed, deep, rows }`, or null.
 * Each row is `{ label, reviewed, fixed, isShared }`, ready for bars.js.
 */
export const shared = load().catch(() => null);

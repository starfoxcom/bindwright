// The evidence section's community block: anonymous counts from people who chose to
// share them, read from the counter (counter/ in the repo). Each project shows as its
// kind only, numbered when a kind repeats. The block stays hidden while the counter is
// down, slow or has no projects yet.
import { t } from "./i18n/index.js";
import { projectRow } from "./bars.js";
import { onEnter } from "./evidence.js";

const COUNTER = "https://bindwright-counter.starfoxcom.workers.dev/total";
const TIMEOUT_MS = 3000;
const KINDS = ["game", "business-app", "developer-tool", "mobile-app", "website", "other"];

const block = document.getElementById("community");
const note = document.getElementById("community-note");
const chart = document.getElementById("community-projects");

// A local preview may read another counter with ?counter=<url>; the live page never does.
function counterUrl() {
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  const override = new URLSearchParams(location.search).get("counter");
  return isLocal && override ? override : COUNTER;
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

// The counter's answer, or null when it is not the shape the block draws.
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
    return { label, reviewed: project.checked, fixed: project.caught };
  });
}

function draw(total) {
  note.textContent = t("evidence.community.note", {
    count: total.projects, checked: total.checked, caught: total.caught, deep: total.deep,
  });
  const rows = labelled(total.top);
  const largest = Math.max(...rows.map((row) => row.reviewed));
  chart.replaceChildren(...rows.map((row, index) => projectRow(row, index, largest)));
  block.hidden = false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) chart.classList.add("counted");
  else onEnter(chart, () => chart.classList.add("counted"));
}

async function load() {
  const response = await fetch(counterUrl(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return;
  const total = checked(await response.json());
  if (total && total.projects > 0 && total.top.length > 0) draw(total);
}

load().catch(() => {});

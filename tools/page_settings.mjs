// Fills the English settings page's rows, and the landing page's mod cards, from
// page/settings-data.js:
//   node tools/page_settings.mjs
// Each group's rows sit between <!-- settings:<group> --> and <!-- /settings:<group> -->;
// the cards sit between <!-- mods:cards --> and <!-- /mods:cards --> on the landing page.
// engine/test/page-settings.test.js and page-mods.test.js fail while a written page is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPUTER, FIXED, MODS_ROWS, PROJECT } from "../page/settings-data.js";

const PAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "page");
const PAGE_FILE = join(PAGE_ROOT, "settings", "index.html");
const LANDING_FILE = join(PAGE_ROOT, "index.html");
const MODS_HEADING = "mods-group";

// The text with the first mention of each linked tool wrapped in a link to its project.
function linked(entry) {
  return Object.entries(entry.links ?? {}).reduce(
    (text, [name, url]) => text.replace(name, `<a href="${url}">${name}</a>`), entry.text);
}

function listItem(prefix, entry, title) {
  return [
    `      <li class="setting" id="s-${entry.id}">`,
    `        <h3 data-t="${prefix}.${entry.id}.title">${title}</h3>`,
    `        <p data-t="${prefix}.${entry.id}.text">${linked(entry)}</p>`,
    `        <span class="setting-value"><span class="setting-label" data-t="settings.default">Default</span>`
      + ` <b data-t="${prefix}.${entry.id}.value">${entry.value}</b></span>`,
    "      </li>",
  ].join("\n");
}

function list(items) {
  return `    <ul class="settings-list">\n${items.join("\n")}\n    </ul>\n`;
}

const rowsOf = (entries) => list(entries.map((entry) => listItem("settings", entry, entry.title)));

// The mods group's heading and intro come from the mods entry of the computer
// group; its rows are one per mod, titled by the mod's name.
function modsBody() {
  const heading = COMPUTER.find((entry) => entry.id === MODS_HEADING);
  const modRows = MODS_ROWS.map((mod) => listItem("mods", mod, `<code>${mod.id}</code>`));
  return [
    `    <h3 id="mods" data-t="settings.${MODS_HEADING}.title">${heading.title}</h3>`,
    `    <p data-t="settings.${MODS_HEADING}.text">${heading.text}</p>`,
    list(modRows),
  ].join("\n");
}

const BODIES = {
  computer: () => rowsOf(COMPUTER.filter((entry) => entry.id !== MODS_HEADING)),
  mods: modsBody,
  project: () => rowsOf(PROJECT),
  fixed: () => rowsOf(FIXED),
};

// The page with each group's markers filled. Markers keep their own lines, so a
// second run rewrites the same text.
export function fillSettings(html) {
  return html.replace(/([ \t]*<!-- settings:(\w+) -->\n)[\s\S]*?([ \t]*<!-- \/settings:\2 -->)/g,
    (match, open, group, close) => {
      if (!(group in BODIES)) throw new Error(`no settings group "${group}"`);
      return open + BODIES[group]() + close;
    });
}

// One card per mod on the landing page, between the mods:cards markers.
const CARDS = /([ \t]*<!-- mods:cards -->\n)[\s\S]*?([ \t]*<!-- \/mods:cards -->)/;

function modCard(mod) {
  return [
    `      <li class="mod-card" id="m-${mod.id}">`,
    `        <h3><code>${mod.id}</code></h3>`,
    `        <p data-t="mods.${mod.id}.text">${mod.text}</p>`,
    `        <span class="setting-value"><span class="setting-label" data-t="settings.default">Default</span>`
      + ` <b data-t="mods.${mod.id}.value">${mod.value}</b></span>`,
    "      </li>",
  ].join("\n");
}

// The landing page with its mod cards filled. The markers keep their own lines, so a
// second run rewrites the same text.
export function fillMods(html) {
  const cards = `    <ul class="mod-cards">\n${MODS_ROWS.map(modCard).join("\n")}\n    </ul>\n`;
  return html.replace(CARDS, (match, open, close) => open + cards + close);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const settings = readFileSync(PAGE_FILE, "utf8").replace(/\r\n/g, "\n");
  writeFileSync(PAGE_FILE, fillSettings(settings));
  console.log("wrote settings/index.html");

  const landing = readFileSync(LANDING_FILE, "utf8").replace(/\r\n/g, "\n");
  writeFileSync(LANDING_FILE, fillMods(landing));
  console.log("wrote index.html");
}

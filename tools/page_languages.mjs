// Writes each translated page from page/index.html and its dictionary:
//   node tools/page_languages.mjs
// engine/test/page-languages.test.js fails while a written page is stale.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTIONARIES } from "../page/i18n/index.js";
import { LANGUAGES } from "../page/i18n/languages.js";
import { renderLanguage } from "../page/i18n/render.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "page");
const english = readFileSync(join(page, "index.html"), "utf8").replace(/\r\n/g, "\n");
for (const { code, folder } of LANGUAGES.filter((l) => l.folder)) {
  const out = join(page, folder, "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderLanguage(english, code, DICTIONARIES[code]));
  console.log(`wrote ${folder}index.html`);
}

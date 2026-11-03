// Writes each translated page from its English page and the language's dictionary:
//   node tools/page_languages.mjs
// engine/test/page-languages.test.js fails while a written page is stale.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTIONARIES } from "../page/i18n/index.js";
import { LANGUAGES, PAGES } from "../page/i18n/languages.js";
import { renderLanguage } from "../page/i18n/render.js";

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "page");
for (const { code, folder } of LANGUAGES.filter((l) => l.folder)) {
  for (const { file, path } of PAGES) {
    const english = readFileSync(join(page, file), "utf8").replace(/\r\n/g, "\n");
    const out = join(page, folder, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderLanguage(english, code, DICTIONARIES[code], path));
    console.log(`wrote ${folder}${file}`);
  }
}

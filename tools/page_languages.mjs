// Stamps each English page's footer with the release in VERSION, then writes each translated
// page from its English page and the language's dictionary, and the sitemap that lists every
// page in every language:
//   node tools/page_languages.mjs
// engine/test/page-languages.test.js fails while a written page is stale.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTIONARIES } from "../page/i18n/index.js";
import { LANGUAGES, PAGES } from "../page/i18n/languages.js";
import { renderLanguage, sitemap, stampVersion } from "../page/i18n/render.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = join(root, "page");
const version = readFileSync(join(root, "VERSION"), "utf8").trim().replace(/^v+/, "");
const english = {};
for (const { file } of PAGES) {
  const path = join(page, file);
  const text = readFileSync(path, "utf8");
  const crlf = text.includes("\r\n");
  english[file] = stampVersion(text.replace(/\r\n/g, "\n"), version);
  const out = crlf ? english[file].replace(/\n/g, "\r\n") : english[file];
  if (out !== text) {
    writeFileSync(path, out);
    console.log(`wrote ${file}`);
  }
}
for (const { code, folder } of LANGUAGES.filter((l) => l.folder)) {
  for (const { file, path } of PAGES) {
    const out = join(page, folder, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderLanguage(english[file], code, DICTIONARIES[code], path));
    console.log(`wrote ${folder}${file}`);
  }
}
writeFileSync(join(root, "sitemap.xml"), sitemap());
console.log("wrote sitemap.xml");

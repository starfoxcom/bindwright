// Builds a language's page from an English page and that language's
// dictionary. The English page marks its text for translation:
//   data-t="key"                 the element's content is the key's text,
//                                which may hold inline markup such as <b>;
//   data-t-attr="name:key ..."   each named attribute is the key's text.
// An element with data-t holds no element of its own tag name.
import { LANGUAGES, SITE } from "./languages.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeAttr = (text) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);

// The "../" that climbs from a folder under the site root back to the root.
const climb = (folder) => "../".repeat(folder.split("/").length - 1);

// The <link rel="alternate"> lines between the alternates markers in <head>.
// `page` is the English page's folder under the site root ("" for index.html).
export function alternates(page = "") {
  const link = (lang, href) => `<link rel="alternate" hreflang="${lang}" href="${href}">`;
  return [...LANGUAGES.map((l) => link(l.code, SITE + l.folder + page)), link("x-default", SITE + page)]
    .join("\n");
}

// The links in the header's language switch: every language but this one, to
// the same page in that language.
export function switchLinks(code, page = "") {
  const here = LANGUAGES.find((l) => l.code === code);
  const back = climb(here.folder + page);
  return LANGUAGES.filter((l) => l.code !== code)
    .map((l) => `<a href="${back + l.folder + page}" hreflang="${l.code}" lang="${l.code}">${l.name}</a>`)
    .join("\n    ");
}

// Every translation key the English page uses, in page order.
export function pageKeys(html) {
  const keys = [...html.matchAll(/\sdata-t="([\w.-]+)"/g)].map((m) => m[1]);
  for (const [, list] of html.matchAll(/\sdata-t-attr="([^"]+)"/g)) {
    keys.push(...list.split(/\s+/).map((pair) => pair.split(":")[1]));
  }
  return keys;
}

// The page for `code`, from the English page and that language's dictionary.
// `page` is the English page's folder under the site root ("" or "settings/").
// A key the dictionary lacks is an error, so a page never ships half-translated.
export function renderLanguage(html, code, words, page = "") {
  const here = LANGUAGES.find((l) => l.code === code);
  const up = climb(here.folder);
  const text = (key) => {
    if (typeof words[key] !== "string") throw new Error(`${code}: no text for "${key}"`);
    return words[key];
  };
  return html
    .replace(/<html lang="[^"]*"/, `<html lang="${code}"`)
    .replace(/(<!-- alternates -->\n)[\s\S]*?(\n<!-- \/alternates -->)/, `$1${alternates(page)}$2`)
    .replace(/(<nav[^>]*\sdata-langs[^>]*>\s*)[\s\S]*?(\s*<\/nav>)/, `$1${switchLinks(code, page)}$2`)
    .replace(/<(\w+)([^>]*?)\sdata-t="([\w.-]+)"([^>]*)>[\s\S]*?<\/\1\s*>/g,
      (m, tag, before, key, after) => `<${tag}${before} data-t="${key}"${after}>${text(key)}</${tag}>`)
    .replace(/<[^>]*\sdata-t-attr="([^"]+)"[^>]*>/g, (tag, list) => {
      let out = tag;
      for (const [name, key] of list.split(/\s+/).map((pair) => pair.split(":"))) {
        out = out.replace(new RegExp(`(\\s${name}=")[^"]*"`), `$1${escapeAttr(text(key))}"`);
      }
      return out;
    })
    .replace(/(\s(?:href|src)=")((?:\.\.\/)*[\w.-]+\.(?:css|js)")/g, `$1${up}$2`);
}

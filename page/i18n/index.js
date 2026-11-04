// Text the page's scripts write, in the page's language. English fills any
// key another language lacks.
import en from "./en.js";
import es from "./es.js";

export const DICTIONARIES = { en, es };

const lang = globalThis.document?.documentElement.lang || "en";
const words = DICTIONARIES[lang] ?? en;
const plurals = new Intl.PluralRules(lang);

// The text for `key`, with each {name} filled from `values`. A text written as
// { one, other } picks its form by values.count, per the language's own rules.
export function t(key, values = {}) {
  let text = words[key] ?? en[key];
  if (text === undefined) throw new Error(`no page text for "${key}"`);
  if (typeof text === "object") text = text[plurals.select(values.count ?? 0)] ?? text.other;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

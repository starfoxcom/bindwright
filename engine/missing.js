// The files a written file's new text names that this update's bind ships but the repo does not
// have, for the `missing` key of --update. A name counts only when it names a file the bind
// ships, or a folder holding one, so a setting key, a code name or an example layout never does.
// missing.py is the Python twin; a test runs both.

import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { safe } from "./apply.js";

// The characters JavaScript's \s matches: a span with one of them is not a single path.
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
// Placeholders, URLs and Windows paths (a backslash, a drive or a share).
const PLACEHOLDER = /[<{*$~\\:]/;
const BACKTICKED = /`([^`\n]+)`/g;
// The folder the templates name a rule from by its bare file name, wherever they point at it.
const RULES = ".claude/rules";

// The backtick-quoted spans of a text, in order.
function spansOf(text) {
  return [...text.matchAll(BACKTICKED)].map((match) => match[1]);
}

// The repo paths a span can name: from the root, from the naming file's folder and, for a bare
// file name, from the rules folder. Only plain relative segments are kept, so no path climbs out
// of the repo or holds a backslash, drive or control character.
function candidatesOf(file, span) {
  if (span.startsWith("/") || PLACEHOLDER.test(span) || WHITESPACE.test(span)) return [];
  const tries = [span, posix.join(posix.dirname(file), span)];
  if (!span.includes("/")) tries.push(posix.join(RULES, span));
  return tries
    .map((candidate) => posix.normalize(candidate).replace(/\/$/, ""))
    .filter((path) => path !== "." && safe(path));
}

// Every path the bind ships, and every folder above one.
function shippedPaths(files) {
  const paths = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end <= parts.length; end += 1) paths.add(parts.slice(0, end).join("/"));
  }
  return paths;
}

// The names one written file gives that the bind ships and the repo lacks, in first-seen order
// without repeats. `priors` are the texts the file had before this update (its base and the
// repo's own copy); the spans they already named are not new.
function unresolvedNames(root, { path, text, priors }, shipped) {
  const known = new Set(priors.flatMap(spansOf));
  const names = [];
  for (const span of spansOf(text)) {
    if (names.includes(span) || known.has(span)) continue;
    const candidates = candidatesOf(path, span);
    if (!candidates.some((candidate) => shipped.has(candidate))) continue;
    if (!candidates.some((candidate) => existsSync(join(root, ...candidate.split("/"))))) names.push(span);
  }
  return names;
}

// The `missing` report for the files an update wrote: one entry per file with unresolved names,
// sorted by path. `bound` lists the repo paths the bind ships.
export function missingReport(root, files, bound) {
  const shipped = shippedPaths(bound);
  const named = new Map();
  for (const file of files) {
    const names = unresolvedNames(root, file, shipped);
    if (names.length) named.set(file.path, names);
  }
  return [...named.keys()].sort().map((file) => ({ file, names: named.get(file) }));
}

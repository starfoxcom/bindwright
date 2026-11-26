// The repo paths a file's new text names that the repo does not have, for the
// `missing` key of --update. missing.py is the Python twin; a test runs both.

import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { safe } from "./apply.js";

// The characters JavaScript's \s matches: a span with one of them is not a single path.
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
// Placeholders, URLs and Windows paths (a backslash, a drive or a share).
const PLACEHOLDER = /[<{*$~\\:]/;
// A file extension starts with a letter, so a version such as 7.19.1 is no path.
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;
const BACKTICKED = /`([^`\n]+)`/g;

// The backtick-quoted spans of a text, in order.
function spansOf(text) {
  return [...text.matchAll(BACKTICKED)].map((match) => match[1]);
}

// A span that may name a repo path: it ends in a file extension or, for a folder, in a slash,
// and is no placeholder, URL, whitespace or absolute path. A branch name such as
// feature/user-auth-flow has neither ending.
function isPathLike(span) {
  const hasShape = span.endsWith("/") || EXTENSION.test(span);
  return hasShape && !PLACEHOLDER.test(span) && !WHITESPACE.test(span) && !span.startsWith("/");
}

// The folder the templates name a rule from by its bare file name, wherever they point at it.
const RULES = ".claude/rules";

// True when the repo holds the span, counted from its root, from the naming file's folder or,
// for a bare file name, from the rules folder. Only plain relative segments are looked up: a
// path that climbs out of the repo, or holds a backslash, drive or control character, is never
// found.
function resolves(root, file, span) {
  const tries = [span, posix.join(posix.dirname(file), span)];
  if (!span.includes("/")) tries.push(posix.join(RULES, span));
  return tries.some((candidate) => {
    const path = posix.normalize(candidate).replace(/\/$/, "");
    return path === "." || (safe(path) && existsSync(join(root, ...path.split("/"))));
  });
}

// The names one written file gives that the repo lacks, in first-seen order without repeats.
// `priors` are the texts the file had before this update (its base and the repo's own copy);
// the spans they already named are not new.
function unresolvedNames(root, { path, text, priors }) {
  const known = new Set(priors.flatMap(spansOf));
  const names = [];
  for (const span of spansOf(text)) {
    if (names.includes(span) || known.has(span) || !isPathLike(span)) continue;
    if (!resolves(root, path, span)) names.push(span);
  }
  return names;
}

// The `missing` report for the files an update wrote: one entry per file with unresolved names,
// sorted by path.
export function missingReport(root, files) {
  const named = new Map();
  for (const file of files) {
    const names = unresolvedNames(root, file);
    if (names.length) named.set(file.path, names);
  }
  return [...named.keys()].sort().map((file) => ({ file, names: named.get(file) }));
}

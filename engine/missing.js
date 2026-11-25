// The repo paths a file's new text names that the repo does not have, for the
// `missing` key of --update. missing.py is the Python twin; a test runs both.

import { existsSync } from "node:fs";
import { join, posix } from "node:path";

// The characters JavaScript's \s matches: a span with one of them is not a single path.
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
// Placeholders and URLs.
const PLACEHOLDER = /[<{*$~]|:\/\//;
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

// True when the repo holds the span, counted from its root or from the naming file's folder.
// A path that climbs out of the repo is never found.
function resolves(root, file, span) {
  const folder = posix.dirname(file);
  return [span, posix.join(folder, span)].some((candidate) => {
    const path = posix.normalize(candidate);
    return path !== ".." && !path.startsWith("../") && existsSync(join(root, ...path.split("/")));
  });
}

// The names one written file gives that the repo lacks, in first-seen order without repeats.
// `base` is the file's text before this update, or undefined for a new file; the spans it
// already named are not new.
function unresolvedNames(root, { path, text, base }) {
  const known = new Set(base === undefined ? [] : spansOf(base));
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

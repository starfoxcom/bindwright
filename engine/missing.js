// The repo paths a file's new text names that the repo does not have, and the section
// names and links that go stale, for the `missing`, `unlinked` and `stale` keys of --update.
// missing.py is the Python twin; a test runs both.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { safe } from "./apply.js";

// The characters JavaScript's \s matches: a span with one of them is not a single path.
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
// Placeholders, URLs and Windows paths (a backslash, a drive or a share).
const PLACEHOLDER = /[<{*$~\\:]/;
// A file extension starts with a letter, so a version such as 7.19.1 is no path.
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;
// A backticked span, then the section text of a `§` reference: the text runs to the line's end
// or to the next backtick.
const SPAN = /`([^`\n]+)`(?: *§ *"?([^`\n]*))?/g;
// A Markdown heading, without its marks and trailing #s.
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;

// The backtick-quoted spans of a text, in order.
function spansOf(text) {
  return [...text.matchAll(SPAN)].map((match) => match[1]);
}

// A span that may name a repo path: it ends in a file extension or, for a folder, in a slash,
// and is no placeholder, URL, whitespace or absolute path. A branch name such as
// feature/user-auth-flow has neither ending.
function isPathLike(span) {
  const hasShape = span.endsWith("/") || EXTENSION.test(span);
  return hasShape && !PLACEHOLDER.test(span) && !WHITESPACE.test(span) && !span.startsWith("/");
}

// The repo paths a span can name, counted from the root and then from the naming file's folder.
// Only plain relative segments are kept, or "." for the root: a path that climbs out of the
// repo, or holds a backslash, drive or control character, is left out, and so is an absolute span.
function candidatesOf(file, span) {
  if (span.startsWith("/")) return [];
  const folder = posix.dirname(file);
  return [span, posix.join(folder, span)]
    .map((candidate) => posix.normalize(candidate).replace(/\/$/, ""))
    .filter((path) => path === "." || safe(path));
}

// The first candidate path that the repo holds or that `known` accepts, or undefined.
function resolvedPath(root, file, span, known = () => false) {
  return candidatesOf(file, span).find(
    (path) => known(path) || existsSync(join(root, ...path.split("/"))),
  );
}

// A repo file's text as it is on disk now, or undefined when it is gone or is no file.
function diskText(root, path) {
  const target = join(root, ...path.split("/"));
  return statSync(target, { throwIfNoEntry: false })?.isFile() ? readFileSync(target, "utf8") : undefined;
}

// The headings of a Markdown text, without their marks and trailing #s.
function headingsOf(text) {
  const matches = text.split("\n").map((line) => HEADING.exec(line));
  return matches.filter((match) => match !== null).map((match) => match[1]);
}

// The longest of `headings` that a section text opens with. The next character must not
// continue a word, so a heading "Use" does not match "Users".
function sectionHeading(section, headings) {
  const opened = headings.filter((heading) => {
    const next = section.charAt(heading.length);
    return section.startsWith(heading) && !/[\p{L}\p{N}]/u.test(next);
  });
  return opened.sort((a, b) => b.length - a.length)[0];
}

// The section ref that one backticked span with its section text makes: {target, name, heading}
// with name "<span> § <heading>". Only a path-like .md span that `resolve` finds, and whose
// headings from `headingsFor` hold the heading, makes one.
function sectionRef(file, span, section, { resolve, headingsFor }) {
  if (section === undefined || !isPathLike(span) || !span.endsWith(".md")) return undefined;
  const target = resolve(file, span);
  const heading = target === undefined ? undefined : sectionHeading(section, headingsFor(target));
  return heading === undefined ? undefined : { target, name: `${span} § ${heading}`, heading };
}

// The section refs of a text that resolve to a heading, in order.
function sectionRefsOf(file, text, options) {
  return [...text.matchAll(SPAN)]
    .map(([, span, section]) => sectionRef(file, span, section, options))
    .filter((ref) => ref !== undefined);
}

// Adds a name once, keeping first-seen order.
function addName(names, name) {
  if (!names.includes(name)) names.push(name);
}

// The names one written file gives that the repo lacks, in first-seen order without repeats.
// `base` is the file's text before this update, or undefined for a new file; the spans and
// section refs it already named are not new. A section ref counts when the repo's copy of its
// file lacks the heading.
function unresolvedNames(root, { path, text, base = "" }, templates) {
  const options = {
    resolve: (file, span) => resolvedPath(root, file, span),
    headingsFor: (target) => (templates.has(target) ? headingsOf(templates.get(target)) : []),
  };
  const known = new Set(spansOf(base));
  const knownRefs = new Set(sectionRefsOf(path, base, options).map((ref) => ref.name));
  const names = [];
  for (const [, span, section] of text.matchAll(SPAN)) {
    if (isPathLike(span) && !known.has(span) && resolvedPath(root, path, span) === undefined) {
      addName(names, span);
    }
    const ref = sectionRef(path, span, section, options);
    if (ref === undefined || knownRefs.has(ref.name)) continue;
    const copy = diskText(root, ref.target);
    if (copy !== undefined && !headingsOf(copy).includes(ref.heading)) addName(names, ref.name);
  }
  return names;
}

// The `missing` report for the files an update wrote: one entry per file with unresolved names,
// sorted by path. `templates` maps each repo path to its rendered text.
export function missingReport(root, files, templates) {
  const named = new Map();
  for (const file of files) {
    const names = unresolvedNames(root, file, templates);
    if (names.length) named.set(file.path, names);
  }
  return [...named.keys()].sort().map((file) => ({ file, names: named.get(file) }));
}

// The base text of a repo path, or undefined when the record holds none.
function baseOf(baseFiles, path) {
  return Object.hasOwn(baseFiles, path) ? baseFiles[path] : undefined;
}

// True when a text has a span that names `file` by path math alone.
function pointsAt(text, owner, file) {
  if (text === undefined) return false;
  return spansOf(text).some((span) => candidatesOf(owner, span).includes(file));
}

// True when the owner's template points at `file` while neither its base text nor its copy in
// the repo does.
function linksTo(root, owner, file, templates, baseFiles) {
  const copy = diskText(root, owner);
  if (copy === undefined || !pointsAt(templates.get(owner), owner, file)) return false;
  const basePoints = pointsAt(baseOf(baseFiles, owner), owner, file);
  return !basePoints && !pointsAt(copy, owner, file);
}

// The `unlinked` report: each added file with the repo files whose template points at it but
// whose base text and repo copy do not, sorted by file. `templates` maps each repo path to its
// rendered text; `baseFiles` is the record's files before the update.
export function unlinkedReport(root, added, templates, baseFiles) {
  return [...added].sort().flatMap((file) => {
    const from = [...templates.keys()]
      .filter((owner) => owner !== file && linksTo(root, owner, file, templates, baseFiles))
      .sort();
    return from.length ? [{ file, from }] : [];
  });
}

// The names one kept file still gives that the update removed: a span that names a removed or
// renamed-away path, and a section ref whose heading the base text of its target held and the
// repo's copy no longer does (or the target is gone).
function staleNames(root, file, gone, options) {
  const names = [];
  for (const [, span, section] of (diskText(root, file) ?? "").matchAll(SPAN)) {
    if (isPathLike(span) && candidatesOf(file, span).some((path) => gone.has(path))) {
      addName(names, span);
    }
    const ref = sectionRef(file, span, section, options);
    if (ref === undefined) continue;
    const copy = diskText(root, ref.target);
    if (copy === undefined || !headingsOf(copy).includes(ref.heading)) addName(names, ref.name);
  }
  return names;
}

// The `stale` report: for each edited file the update kept, the names it gives that the update
// dropped, sorted by file. `plan` is the outcome lists of planUpdate; `baseFiles` is the
// record's files before the update.
export function staleReport(root, plan, baseFiles) {
  const gone = new Set([...plan.removed, ...plan.renamed.map(([from]) => from)]);
  const inBase = (path) => Object.hasOwn(baseFiles, path);
  const options = {
    resolve: (file, span) => resolvedPath(root, file, span, inBase),
    headingsFor: (target) => (inBase(target) ? headingsOf(baseFiles[target]) : []),
  };
  return [...plan.removed_edited].sort().flatMap((file) => {
    const names = staleNames(root, file, gone, options);
    return names.length ? [{ file, names }] : [];
  });
}

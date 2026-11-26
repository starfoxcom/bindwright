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
// A backticked span, then the section text of a `§` reference: the text runs to the line's end
// or to the next backtick.
const SPAN = /`([^`\n]+)`(?: *§ *"?([^`\n]*))?/g;
// A Markdown heading, without its marks and trailing #s. Only spaces and tabs separate them, as
// CommonMark has it, so both engines read the same heading; a line read with Windows endings keeps
// its \r, which the end takes off.
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*\r?$/;

// The backtick-quoted spans of a text, in order.
function spansOf(text) {
  return [...text.matchAll(SPAN)].map((match) => match[1]);
}

// The folder the templates name a rule from by its bare file name, wherever they point at it.
const RULES = ".claude/rules";

// The repo paths a span can name: from the root, from the naming file's folder and, for a bare
// file name, from the rules folder. Only plain relative segments are kept, so no path climbs out
// of the repo or holds a backslash, drive or control character, and a placeholder, URL or
// absolute span names none.
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

// True when a span names a path the bind ships and the repo has it at none of the span's places.
function isMissing(root, file, span, shipped) {
  const candidates = candidatesOf(file, span);
  return candidates.some((candidate) => shipped.has(candidate))
    && !candidates.some((candidate) => existsSync(join(root, ...candidate.split("/"))));
}

// The first candidate path that the repo holds or that `known` accepts, or undefined.
function resolvedPath(root, file, span, known = () => false) {
  return candidatesOf(file, span).find(
    (path) => known(path) || existsSync(join(root, ...path.split("/"))),
  );
}

// A repo file's text as it is on disk now, or undefined when it is gone, is no file or cannot be
// read. The reports run after the update's writes, so a read that fails counts as no copy.
function diskText(root, path) {
  const target = join(root, ...path.split("/"));
  try {
    return statSync(target, { throwIfNoEntry: false })?.isFile() ? readFileSync(target, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

// The headings of a Markdown text, without their marks and trailing #s.
function headingsOf(text) {
  const matches = text.split("\n").map((line) => HEADING.exec(line));
  return matches.filter((match) => match !== null).map((match) => match[1]);
}

// The longest of `headings` that a section text opens with. The next character must not
// continue a word, so a heading "Use" does not match "Users". It is read as a whole code point,
// as Python reads it, so a letter outside the Basic Multilingual Plane continues the word too.
function sectionHeading(section, headings) {
  const opened = headings.filter((heading) => {
    const code = section.codePointAt(heading.length);
    const next = code === undefined ? "" : String.fromCodePoint(code);
    return section.startsWith(heading) && !/[\p{L}\p{N}]/u.test(next);
  });
  return opened.sort((a, b) => b.length - a.length)[0];
}

// The section ref that one backticked span with its section text makes: {target, name, heading}
// with name "<span> § <heading>". Only a path-like .md span that `resolve` finds, and whose
// headings from `headingsFor` hold the heading, makes one.
function sectionRef(file, span, section, { resolve, headingsFor }) {
  if (section === undefined || !span.endsWith(".md")) return undefined;
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

// The names one written file gives that the bind ships and the repo lacks, in first-seen order
// without repeats. `priors` are the texts the file had before this update (its base and the
// repo's own copy); the spans and section refs they already named are not new. A section ref
// counts when the repo's copy of its file lacks the heading.
function unresolvedNames(root, { path, text, priors }, templates, shipped) {
  const options = {
    resolve: (file, span) => resolvedPath(root, file, span),
    headingsFor: (target) => (templates.has(target) ? headingsOf(templates.get(target)) : []),
  };
  const known = new Set(priors.flatMap(spansOf));
  const priorRefs = priors.flatMap((prior) => sectionRefsOf(path, prior, options));
  const knownRefs = new Set(priorRefs.map((ref) => ref.name));
  const names = [];
  for (const [, span, section] of text.matchAll(SPAN)) {
    if (!known.has(span) && isMissing(root, path, span, shipped)) addName(names, span);
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
  const shipped = shippedPaths(templates.keys());
  const named = new Map();
  for (const file of files) {
    const names = unresolvedNames(root, file, templates, shipped);
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
  if (!pointsAt(templates.get(owner), owner, file)) return false;
  const copy = diskText(root, owner);
  if (copy === undefined) return false;
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

// True when the update took a section out: its target was removed or renamed away, or today's
// template of the target lacks the heading and so does the repo's copy.
function isSectionGone(root, ref, gone, templates) {
  if (gone.has(ref.target)) return true;
  if (!templates.has(ref.target) || headingsOf(templates.get(ref.target)).includes(ref.heading)) {
    return false;
  }
  const copy = diskText(root, ref.target);
  return copy === undefined || !headingsOf(copy).includes(ref.heading);
}

// The names one kept file still gives that the update removed: a span that names a removed or
// renamed-away path, and a section ref whose heading the base text of its target held and the
// update took out.
function staleNames(root, file, gone, templates, options) {
  const names = [];
  for (const [, span, section] of (diskText(root, file) ?? "").matchAll(SPAN)) {
    if (candidatesOf(file, span).some((path) => gone.has(path))) {
      addName(names, span);
    }
    const ref = sectionRef(file, span, section, options);
    if (ref !== undefined && isSectionGone(root, ref, gone, templates)) addName(names, ref.name);
  }
  return names;
}

// The `stale` report: for each edited file the update kept, the names it gives that the update
// dropped, sorted by file. `plan` is the outcome lists of planUpdate; `templates` maps each repo
// path to its rendered text; `baseFiles` is the record's files before the update.
export function staleReport(root, plan, templates, baseFiles) {
  const gone = new Set([...plan.removed, ...plan.renamed.map(([from]) => from)]);
  const inBase = (path) => Object.hasOwn(baseFiles, path);
  const options = {
    resolve: (file, span) => resolvedPath(root, file, span, inBase),
    headingsFor: (target) => (inBase(target) ? headingsOf(baseFiles[target]) : []),
  };
  return [...plan.removed_edited].sort().flatMap((file) => {
    const names = staleNames(root, file, gone, templates, options);
    return names.length ? [{ file, names }] : [];
  });
}

// Setup's merge proposals: how each file staged in .bindwright/incoming/ would merge into the
// repo's own copy at the same path. Read only; nothing is written. The Python twin is propose.py.

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { STAGING_FOLDERS } from "./staging.js";

const INCOMING = STAGING_FOLDERS[0];
// Arrays merged as unions, by dotted key path. Hook lists (hooks.<Event>) merge the same way.
const UNION_PATHS = new Set(["permissions.allow", "permissions.deny", "permissions.ask"]);
const HEADING = /^#{1,6} /;
const FENCE = /^(`{3,}|~{3,})/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The JSON of a value with its keys sorted, so two values compare equal when their JSON does.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The lstat of `path`, or null when nothing is there.
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// The text of the file at `path`, or null when there is no file there.
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

const OUTSIDE = Symbol("outside the repo");

// The text of the repo's copy of `path`, null when it has none, or OUTSIDE when a link in its
// path leads out of the repo: a repo must not get a file elsewhere printed into the session.
function repoCopy(repoDir, path) {
  let real;
  try {
    real = realpathSync(join(repoDir, path));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
  const inRepo = relative(realpathSync(repoDir), real);
  if (inRepo === ".." || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo)) return OUTSIDE;
  return readText(real);
}

// The files under `folder`, relative to it with "/" between parts. A symbolic link or a Windows
// junction is skipped, never followed.
function stagedFiles(folder, prefix = "") {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return stagedFiles(path, `${prefix}${name}/`);
    return entry.isFile() ? [`${prefix}${name}`] : [];
  });
}

/** The merge proposal for each file staged in `<repoDir>/.bindwright/incoming/`, sorted by path. */
export function proposeMerges(repoDir) {
  const incoming = join(repoDir, INCOMING);
  const entry = lstatOrNull(incoming);
  if (entry === null || !entry.isDirectory()) return { proposals: [] };
  const proposals = stagedFiles(incoming).sort().map((path) => {
    const repoText = repoCopy(repoDir, path);
    if (repoText === OUTSIDE) return { path, kind: "text" };
    return proposeMerge(path, repoText, readText(join(incoming, path)));
  });
  return { proposals };
}

/**
 * The proposal for one file. `repoText` is the repo's copy, or null when the repo has no file at
 * that path. Both texts are compared with CRLF read as LF.
 */
export function proposeMerge(path, repoText, incomingText) {
  if (repoText === null) return { path, kind: "missing" };
  const repo = normalise(repoText);
  const incoming = normalise(incomingText);
  if (repo === incoming) return { path, kind: "identical" };
  if (path.endsWith(".md")) return { path, kind: "markdown", ...compareSections(repo, incoming) };
  const json = path.endsWith(".json") ? jsonProposal(path, repo, incoming) : null;
  return json ?? { path, kind: "text" };
}

const normalise = (text) => text.replace(/\r\n/g, "\n");

// JSON: both sides parse as objects, merged key by key. Null when either side is not one.
function jsonProposal(path, repo, incoming) {
  const repoObject = parseObject(repo);
  const incomingObject = parseObject(incoming);
  if (repoObject === null || incomingObject === null) return null;
  const clashes = [];
  const merged = mergeObjects(repoObject, incomingObject, [], clashes);
  return { path, kind: "json", merged, text: `${JSON.stringify(merged, null, 2)}\n`, clashes };
}

// The parsed object, or null when the text is not JSON or not an object.
function parseObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}

// The repo's keys in its order, each merged with the staged copy's, then the keys only the
// staged copy has, in its order.
function mergeObjects(repo, incoming, path, clashes) {
  const shared = Object.keys(repo).map((key) => [key, Object.hasOwn(incoming, key)
    ? mergeValue(repo[key], incoming[key], [...path, key], clashes)
    : repo[key]]);
  const stagedOnly = Object.keys(incoming)
    .filter((key) => !Object.hasOwn(repo, key))
    .map((key) => [key, incoming[key]]);
  return Object.fromEntries([...shared, ...stagedOnly]);
}

// The value both sides set at `path`. Equal values keep the repo's; a value that differs keeps
// the repo's and is reported as a clash.
function mergeValue(repo, incoming, path, clashes) {
  if (isObject(repo) && isObject(incoming)) return mergeObjects(repo, incoming, path, clashes);
  if (Array.isArray(repo) && Array.isArray(incoming) && isListPath(path)) {
    return appendMissing(repo, incoming);
  }
  if (canonical(repo) !== canonical(incoming)) {
    clashes.push({ key: path.join("."), repo, incoming });
  }
  return repo;
}

function isListPath(path) {
  return UNION_PATHS.has(path.join(".")) || (path.length === 2 && path[0] === "hooks");
}

// `list` plus each item of `extra` not already in it, in order.
function appendMissing(list, extra) {
  const seen = new Set(list.map(canonical));
  const merged = [...list];
  for (const item of extra) {
    const key = canonical(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// Markdown: sections matched by heading. A section lists the staged copy's sections the repo
// lacks (add), the ones both have that differ (differ), and the repo's headings the staged copy
// lacks (repoOnly).
function compareSections(repo, incoming) {
  const repoSections = keyed(sectionsOf(repo));
  const incomingSections = keyed(sectionsOf(incoming));
  const incomingByKey = new Map(incomingSections.map((section) => [section.key, section]));
  const repoKeys = new Set(repoSections.map((section) => section.key));
  const pairs = repoSections
    .filter((section) => incomingByKey.has(section.key))
    .map((section) => [section, incomingByKey.get(section.key)]);
  return {
    add: incomingSections
      .filter((section) => !repoKeys.has(section.key))
      .map(({ heading, text }) => ({ heading, text })),
    differ: pairs
      .filter(([repoSection, incomingSection]) => (
        repoSection.text.trimEnd() !== incomingSection.text.trimEnd()
      ))
      .map(([repoSection, incomingSection]) => ({
        heading: repoSection.heading,
        repo: repoSection.text,
        incoming: incomingSection.text,
      })),
    repoOnly: repoSections
      .filter((section) => !incomingByKey.has(section.key))
      .map((section) => section.heading),
  };
}

// Each section with a key: its heading and which copy of that heading it is.
function keyed(sections) {
  const seen = new Map();
  return sections.map((section) => {
    const nth = seen.get(section.heading) ?? 0;
    seen.set(section.heading, nth + 1);
    return { ...section, key: `${section.heading}\n${nth}` };
  });
}

// The text before the first heading (heading ""), then one section per heading. A section runs
// from its heading line to just before the next one. Headings inside code fences do not count.
function sectionsOf(text) {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const sections = [{ heading: "", lines: [] }];
  lines.forEach((line, i) => {
    if (!fenced[i] && HEADING.test(line)) sections.push({ heading: line.trim(), lines: [] });
    sections[sections.length - 1].lines.push(line);
  });
  return sections.map(({ heading, lines: body }) => ({ heading, text: body.join("\n") }));
}

// For each line, whether it sits in a fenced code block, its fence lines included.
function fencedLines(lines) {
  let fence = null;
  return lines.map((line) => {
    if (fence === null) {
      fence = FENCE.exec(line)?.[1] ?? null;
      return fence !== null;
    }
    if (closesFence(line, fence)) fence = null;
    return true;
  });
}

// A closing fence is a run of the opening fence's character, at least as long, and nothing else.
function closesFence(line, fence) {
  const run = line.trim();
  return run.length >= fence.length && [...run].every((char) => char === fence[0]);
}

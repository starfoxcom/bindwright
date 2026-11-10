// Setup's merge proposals: how each file staged in .bindwright/incoming/ would merge into the
// repo's own copy at the same path. Read only; nothing is written. The Python twin is propose.py.

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { STAGING_FOLDERS, entryAt } from "./staging.js";
import { MAX_DEPTH, depthOf } from "./setupcode.js";

const INCOMING = STAGING_FOLDERS[0];
// An all-digit key, which JavaScript objects move to the front.
const INDEX_KEY = /^\d+$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// The permissions.<list> arrays merged as unions; hook lists (hooks.<Event>) merge the same way.
const UNION_PERMISSIONS = new Set(["allow", "deny", "ask"]);
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

// The text of the file at `path`, or null when there is no file there.
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

const UNREADABLE = Symbol("not one file inside the repo");

// The text of the repo's copy of `path`, null when it has none, or UNREADABLE when it is not one
// file inside the repo: a folder, a link loop, or a link out of the repo, whose target must not
// get printed into the session.
function repoCopy(repoDir, path) {
  let real;
  try {
    real = realpathSync(join(repoDir, path));
  } catch (err) {
    return err.code === "ENOENT" || err.code === "ENOTDIR" ? null : UNREADABLE;
  }
  const inRepo = relative(realpathSync(repoDir), real);
  if (inRepo === ".." || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo)) return UNREADABLE;
  return lstatSync(real).isFile() ? readText(real) : UNREADABLE;
}

// Whether `folder` is a real folder: a link or junction to one is never followed.
function isRealFolder(folder) {
  const entry = entryAt(folder);
  return entry !== null && entry.isDirectory();
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
  if (!isRealFolder(dirname(incoming)) || !isRealFolder(incoming)) return { proposals: [] };
  const proposals = stagedFiles(incoming).sort().map((path) => {
    const repoText = repoCopy(repoDir, path);
    if (repoText === UNREADABLE) return { path, kind: "unread" };
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

// The parsed object, or null when the text is not plain JSON: an object both engines read and
// print alike (see isPlain), nested at most MAX_DEPTH deep.
function parseObject(text) {
  if (depthOf(text) > MAX_DEPTH) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isObject(value) && isPlain(value) ? value : null;
}

// Whole numbers in the safe range, no all-digit keys and no lone surrogates: past these the
// Python twin would read or print the value differently, so the file is merged by hand instead.
function isPlain(value) {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "string") return !LONE_SURROGATE.test(value);
  if (Array.isArray(value)) return value.every(isPlain);
  if (!isObject(value)) return true;
  return Object.entries(value).every(([key, item]) => (
    !INDEX_KEY.test(key) && !LONE_SURROGATE.test(key) && isPlain(item)
  ));
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
    return path[0] === "hooks" ? mergeHookEntries(repo, incoming) : appendMissing(repo, incoming);
  }
  if (canonical(repo) !== canonical(incoming)) {
    clashes.push({ key: path.join("."), repo, incoming });
  }
  return repo;
}

function isListPath(path) {
  if (path.length !== 2) return false;
  return path[0] === "hooks" || (path[0] === "permissions" && UNION_PERMISSIONS.has(path[1]));
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

// One event's hook entries: a staged entry whose matcher a repo entry already has adds the
// hooks no entry with that matcher holds to the first of them, so no matcher gains a second
// entry and no hook is listed twice; any other new entry is appended.
function mergeHookEntries(list, extra) {
  const merged = list.map((entry) => (isObject(entry) ? { ...entry } : entry));
  const hasHooks = (entry) => isObject(entry) && Array.isArray(entry.hooks);
  const matcherOf = (entry) => canonical(entry.matcher ?? null);
  for (const item of extra) {
    const same = hasHooks(item)
      ? merged.filter((entry) => hasHooks(entry) && matcherOf(entry) === matcherOf(item))
      : [];
    if (same.length > 0) {
      const present = same.flatMap((entry) => entry.hooks);
      same[0].hooks = [...same[0].hooks, ...appendMissing(present, item.hooks).slice(present.length)];
    } else if (!merged.some((entry) => canonical(entry) === canonical(item))) merged.push(item);
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

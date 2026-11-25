// /bindwright:update's engine step: a three-way merge of each repo file. The
// base is the file as the last bind rendered it (.bindwright/pristine.json),
// ours is the repo's copy, theirs is the same answers rendered from today's
// templates. update.py is the Python twin; a test runs both on the same cases.

import { execFileSync } from "node:child_process";
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { STAGING, ANSWERS, PRISTINE, stateJson } from "./bind.js";
import { OWNED, isOwned, keptSections, ownedPatterns } from "./keep.js";
import { safe, refuseLinks } from "./apply.js";
import { expandAnswers } from "./model.js";
import { parsePlainObject } from "./propose.js";
import { missingReport } from "./missing.js";

// The file in git's folder that holds the pristine record the last update replaced.
const BEFORE = "bindwright-pristine-before.json";

// The rendered repo files under the paths they belong at, as the pristine
// render records them: staged ones without the staging prefix, and none of
// setup's own files.
export function repoFiles(rendered) {
  const out = new Map();
  for (const [dest, text] of rendered) {
    if (dest.startsWith(STAGING)) out.set(dest.slice(STAGING.length), text);
    else if (!dest.startsWith(".bindwright/")) out.set(dest, text);
  }
  return out;
}

// True when every kept section of `ours` survives in `merged` word for word.
function keepsSections(ours, merged, path) {
  const lines = ours.split("\n");
  return keptSections(ours, path).every(([first, last]) => merged.includes(lines.slice(first - 1, last).join("\n")));
}

// What can happen to a file. "deleted": the repo removed a file the bind
// wrote, which stays removed; "removed": the templates dropped a file the repo
// never changed, which the skill offers to delete; "removed_edited": the same
// for a file the repo changed, which stays.
export const OUTCOMES = [
  "updated", "merged", "added", "staged", "unchanged", "conflict", "owned", "deleted", "removed", "removed_edited",
];

// Files the templates moved, old path to new. An update merges the repo's copy
// at the old path, edits included, into the new path and deletes the old file.
export const RENAMES = {
  ".claude/skills/session-close/SKILL.md": ".claude/skills/close-session/SKILL.md",
  ".claude/skills/session-start/SKILL.md": ".claude/skills/start-session/SKILL.md",
};

// The renames this update carries out, new path to old: the bind last wrote
// the old path, today's templates have only the new one, and the repo holds
// nothing at the new path and owns neither.
function movesFor(theirsAll, pristine, { readRepo, owned }) {
  const moves = new Map();
  for (const [from, to] of Object.entries(RENAMES)) {
    const due = theirsAll.has(to) && !theirsAll.has(from) && from in pristine.files && !(to in pristine.files);
    if (due && !isOwned(from, owned) && !isOwned(to, owned) && readRepo(to) === null) moves.set(to, from);
  }
  return moves;
}

// The old path a renamed file is owned through: the project owns that path and
// still has it (a file there, or the base the bind last wrote), and the repo has
// nothing at the new one. The template then adds no second copy, and the new path
// is not recorded as written, so the file arrives once the claim is dropped: moved
// when the old path's base is kept, added when it is not.
function ownedOldPath(path, { pristine, owned, readRepo }) {
  return Object.keys(RENAMES).find((old) => RENAMES[old] === path && isOwned(old, owned)
    && (old in pristine.files || readRepo(old) !== null) && readRepo(path) === null);
}

function decide(path, { ours, base, theirs }, merge) {
  if (theirs === undefined) {
    if (ours === null) return ["deleted"];
    return ours === base ? ["removed"] : ["removed_edited"];
  }
  if (base === undefined) {
    if (ours === null) return ["added", theirs];
    return ours === theirs ? ["unchanged"] : ["staged", theirs];
  }
  if (ours === null) return ["deleted"];
  if (ours === theirs || base === theirs) return ["unchanged"];
  if (ours === base) return ["updated", theirs];
  const { text, conflicts } = merge(ours, base, theirs);
  // Git's line merge cannot place a key the repo moved; a key-by-key merge can.
  if (conflicts && path.endsWith(".json")) {
    const merged = mergeJson(ours, base, theirs);
    if (merged !== null && keepsSections(ours, merged, path)) return ["merged", merged];
  }
  if (conflicts || !keepsSections(ours, text, path)) return ["conflict", text];
  return ["merged", text];
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The base a file is decided against: the text keepBase held back, when the repo holds exactly
// that text, else the record's base. Only own keys of `held` count.
function baseFor(pristine, path, ours) {
  const held = isObject(pristine.held) ? pristine.held : {};
  const heldText = Object.hasOwn(held, path) ? held[path] : undefined;
  return typeof heldText === "string" && heldText === ours ? heldText : pristine.files[path];
}

// Decides every file. `rendered` is the new bind's Map, `pristine` the parsed
// pristine.json, `readRepo(path)` the repo's text or null, `owned` the
// patterns from .bindwright/owned, `merge(ours, base, theirs)` gives
// { text, conflicts }. Returns the lists by outcome, the files to write and
// stage, and the new pristine render. A conflicted file is staged as the
// merge left it, markers and all, and its base still moves on, so once the
// user settles it the next update does not raise the same clash again.
// A repo copy equal to the text in `pristine.held` is decided against that
// text as its base.
export function planUpdate(rendered, pristine, { readRepo, owned, merge, version }) {
  const theirsAll = repoFiles(rendered);
  const paths = [...new Set([...Object.keys(pristine.files), ...theirsAll.keys()])].sort();
  const result = { write: [], stage: [], pristine: {}, renamed: [], remove: [], owned_changed: [] };
  for (const outcome of OUTCOMES) result[outcome] = [];
  const moves = movesFor(theirsAll, pristine, { readRepo, owned });
  const movedFrom = new Set(moves.values());
  for (const path of paths) {
    if (movedFrom.has(path)) continue;
    const from = moves.get(path);
    const theirs = theirsAll.get(path);
    const ownedOld = ownedOldPath(path, { pristine, owned, readRepo });
    if (ownedOld !== undefined || isOwned(path, owned)) {
      result.owned.push(path);
      if (ownedOld !== undefined) {
        if (ownedOld in pristine.files) result.pristine[ownedOld] = pristine.files[ownedOld];
      } else if (theirs !== undefined) {
        result.pristine[path] = theirs;
        // The templates changed a file the project owns: the project's copy never gets it by itself,
        // so the new text waits in the staging folder until someone settles it.
        if (pristine.files[path] !== theirs) {
          result.owned_changed.push(path);
          result.stage.push([STAGING + path, theirs]);
        }
      }
      continue;
    }
    const ours = readRepo(from ?? path);
    const base = baseFor(pristine, from ?? path, ours);
    const [outcome, text] = decide(path, { ours, base, theirs }, merge);
    result[outcome].push(path);
    if (outcome === "updated" || outcome === "merged" || outcome === "added") result.write.push([path, text]);
    if (outcome === "staged" || outcome === "conflict") result.stage.push([STAGING + path, text]);
    // A moved file the merge leaves as it was, or stages, still lands at its new path.
    if (from && (outcome === "unchanged" || outcome === "conflict")) result.write.push([path, ours]);
    if (from && ours !== null) {
      result.renamed.push([from, path]);
      result.remove.push(from);
    }
    if (theirs !== undefined) result.pristine[path] = theirs;
  }
  result.pristine = { version, year: pristine.year, files: result.pristine };
  return result;
}

// A three-way merge by git, which every set-up repo has: its exit status is
// the number of conflicts. Each clash shows all three versions, labelled.
export const MERGE_LABELS = ["this repo", "last setup or update", "today's templates"];

export function gitMerge(ours, base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), "bindwright-merge-"));
  try {
    const at = (name, text) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    };
    const labels = MERGE_LABELS.flatMap((l) => ["-L", l]);
    const args = ["merge-file", "-p", "--diff3", ...labels, at("ours", ours), at("base", base), at("theirs", theirs)];
    try {
      return { text: decode(execFileSync("git", args), "git merge-file's output"), conflicts: 0 };
    } catch (err) {
      const clashes = typeof err.status === "number" && err.status > 0 && err.status < 128;
      if (clashes) return { text: decode(err.stdout, "git merge-file's output"), conflicts: err.status };
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BOM = "\uFEFF";
const ABSENT = Symbol("absent");
const CLASH = Symbol("clash");
const MAX_INDENT = 10; // JSON.stringify uses at most 10 characters of an indent string

// A key-by-key three-way merge of three JSON objects, for the clashes git's line
// merge reports when the repo moved keys. Null when a value clashes or a text is
// not a JSON object both twins reprint alike.
function mergeJson(ours, base, theirs) {
  const parsed = [ours, base, theirs].map(parseObject);
  if (parsed.includes(null)) return null;
  const merged = mergeValue(...parsed);
  if (merged === CLASH) return null;
  const indent = indentOf(ours);
  if (indent.length > MAX_INDENT) return null;
  const body = JSON.stringify(merged, null, indent);
  return (ours.startsWith(BOM) ? BOM : "") + body + (ours.endsWith("\n") ? "\n" : "");
}

// The object of a text the twins both read and reprint alike (propose.js holds those rules),
// with no key repeated.
function parseObject(text) {
  const plain = text.startsWith(BOM) ? text.slice(1) : text;
  const value = parsePlainObject(plain);
  return value !== null && !repeatsAKey(plain) ? value : null;
}

// Whether an object in the text, already read as plain JSON, holds a key twice: JSON.parse
// keeps only the last copy, so the reprint would drop the others.
function repeatsAKey(text) {
  const objects = [];
  let previous = null;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)) {
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else if (token === ":") {
      const keys = objects.at(-1);
      const key = JSON.parse(previous);
      if (keys.has(key)) return true;
      keys.add(key);
    }
    previous = token;
  }
  return false;
}

// The indent the repo's copy uses: the leading whitespace of its first indented line, found
// after a \n only, as the Python twin finds it.
function indentOf(text) {
  const match = /\n([ \t]+)\S/.exec(text);
  return match ? match[1] : "  ";
}

// ABSENT stands for a key a version does not have. A value that every version
// changed differently is CLASH. Objects merge key by key first, so the repo's
// key order holds even where it changed nothing else.
function mergeValue(o, b, t) {
  if (isObject(o) && isObject(b) && isObject(t)) return mergeObject(o, b, t);
  if (same(o, t)) return o;
  if (same(o, b)) return t;
  if (same(t, b)) return o;
  return CLASH;
}

// The repo's keys in its order, then the keys only the templates have.
function mergeObject(o, b, t) {
  const keys = [...Object.keys(o), ...Object.keys(t).filter((key) => !Object.hasOwn(o, key))];
  const entries = [];
  for (const key of keys) {
    const value = mergeValue(member(o, key), member(b, key), member(t, key));
    if (value === CLASH) return CLASH;
    if (value !== ABSENT) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

const member = (object, key) => (isObject(object) && Object.hasOwn(object, key) ? object[key] : ABSENT);

// Objects compare without regard to key order, arrays in order.
function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

// Strict UTF-8 that keeps a byte order mark, as Python's decoder does: a file
// that is not UTF-8 stops the update instead of being written back damaged.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decode(bytes, what) {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`${what} is not UTF-8 text`);
  }
}

// Why a file cannot be read, in the words update.py and layers.py share.
const UNREADABLE = {
  EISDIR: "it is a folder",
  ENOTDIR: "a folder above it is a file",
  EACCES: "permission denied",
  EPERM: "permission denied",
};

// True when a folder above `path` is a file.
function fileAbove(path) {
  for (let above = dirname(path); above !== dirname(above); above = dirname(above)) {
    if (statSync(above, { throwIfNoEntry: false })?.isFile()) return true;
  }
  return false;
}

// The bytes of a file, or null when it is missing. Any other failure to read
// it is refused with the file's name and the reason.
export function readState(path, file) {
  try {
    return readFileSync(path);
  } catch (err) {
    if (err.code === "ENOENT" && !fileAbove(path)) return null;
    // Windows reports a path under a file as ENOENT, which means ENOTDIR here.
    const code = err.code === "ENOENT" ? "ENOTDIR" : err.code;
    throw new Error(`${file} cannot be read (${UNREADABLE[code] ?? code ?? "unknown error"})`);
  }
}

// The repo's text at a path with \r\n turned into \n, or null when it has none.
export function reader(root) {
  return (path) => {
    const bytes = readState(join(root, ...path.split("/")), path);
    return bytes === null ? null : decode(bytes, path).replace(/\r\n/g, "\n");
  };
}

function put(root, path, text, flag = "w") {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, { encoding: "utf8", flag });
}

// Deletes a moved file's old copy, then its folder once nothing else is in it.
function removeMoved(root, path) {
  const target = join(root, ...path.split("/"));
  rmSync(target, { force: true });
  try {
    if (readdirSync(dirname(target)).length === 0) rmdirSync(dirname(target));
  } catch {
    // The folder is gone or still holds the project's own files.
  }
}

// What sits at a path without following a link: "link", "other" or null.
function entry(root, path) {
  const stat = lstatSync(join(root, ...path.split("/")), { throwIfNoEntry: false });
  if (!stat) return null;
  return stat.isSymbolicLink() ? "link" : "other";
}

// Binds the saved answers with today's templates and the saved year, writes
// what merged cleanly, stages new files the repo already has and conflicts,
// and records the new pristine render. `bindWith(answers, { year, version })`
// returns a bind. Returns every outcome list plus `skipped`: staged copies
// left from before, which stay as they were; and `missing`: the repo paths
// the written files name that the repo lacks (missing.js).
export async function runUpdate(root, { bindWith, version }) {
  const read = reader(root);
  const [answers, saved] = [ANSWERS, PRISTINE].map(read);
  if (answers === null || saved === null) {
    throw new Error(`${ANSWERS} or ${PRISTINE} is missing: this repo was not set up with /bindwright:setup`);
  }
  const pristine = JSON.parse(saved);
  const bad = Object.keys(pristine.files).filter((p) => !safe(p));
  if (bad.length) throw new Error(`Refusing paths outside the repo in ${PRISTINE}: ${bad.join(", ")}`);
  const rendered = await bindWith(expandAnswers(JSON.parse(answers)), { year: pristine.year, version });
  const owned = ownedPatterns(read(OWNED) ?? "");
  const plan = planUpdate(rendered, pristine, { readRepo: read, owned, merge: gitMerge, version });
  // Every check before the first write, so a refusal leaves the repo as it was.
  // A staged copy that already exists is skipped, not written, so it is not checked.
  const freshStaged = plan.stage.map(([path]) => path).filter((path) => entry(root, path) === null);
  refuseLinks(root, [...plan.write.map(([path]) => path), PRISTINE, ...freshStaged, ...plan.remove]);
  const skipped = plan.stage.filter(([path]) => entry(root, path) !== null).map(([path]) => path.slice(STAGING.length));
  const renamedFrom = Object.fromEntries(Object.entries(RENAMES).map(([from, to]) => [to, from]));
  for (const path of skipped) {
    // The old staged copy is unsettled, so its file keeps the old base and the next update stages it again.
    // A renamed file's base is still under its old name.
    const base = path in pristine.files ? path : renamedFrom[path];
    if (base in pristine.files) plan.pristine.files[path] = pristine.files[base];
    else delete plan.pristine.files[path];
  }
  // The replaced record is saved first, so a failure to save it stops the update before any repo write.
  const before = beforePath(root);
  if (before !== null) writeFileSync(before, saved);
  for (const [path, text] of plan.write) put(root, path, text);
  for (const [path, text] of plan.stage) {
    if (!skipped.includes(path.slice(STAGING.length))) put(root, path, text, "wx");
  }
  for (const path of plan.remove) removeMoved(root, path);
  put(root, PRISTINE, stateJson(plan.pristine));
  return {
    ...Object.fromEntries(OUTCOMES.map((o) => [o, plan[o]])),
    renamed: plan.renamed,
    owned_changed: plan.owned_changed,
    skipped,
    missing: missingReport(root, writtenFiles(plan, pristine)),
  };
}

// The files this update wrote with a new text (added, merged or updated), each with that text
// and the base it had in the record before the update.
function writtenFiles(plan, pristine) {
  const written = new Map(plan.write);
  return [...plan.added, ...plan.merged, ...plan.updated].map((path) => ({
    path, text: written.get(path), base: pristine.files[path],
  }));
}

// A pristine record parsed from its JSON text, with a files object; anything else is refused,
// naming `what`.
function recordOf(text, what) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    record = null;
  }
  if (!isObject(record) || !isObject(record.files)) throw new Error(`${what} holds no record of the files setup wrote`);
  return record;
}

// Where an update keeps the record it replaced, as dpkg and ucf keep a config file's previous copy:
// inside git's own folder, so it is never committed, also where .bindwright/ stays out of git. Null
// outside a git repo.
function beforePath(root) {
  try {
    const args = ["-C", root, "rev-parse", "--git-path", BEFORE];
    const out = execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] });
    const path = decode(out, "git's answer").trim();
    return isAbsolute(path) ? path : join(root, path);
  } catch {
    return null;
  }
}

// An object with the map's keys in sorted order. defineProperty, since a plain assignment to
// "__proto__" would set the prototype instead.
function sortedObject(map) {
  const object = {};
  for (const key of [...map.keys()].sort()) {
    Object.defineProperty(object, key, { value: map.get(key), enumerable: true, writable: true });
  }
  return object;
}

// Puts each path's base back to the one the last update decided it against (the replaced record's
// base, or the text that record held when the repo still holds it), for files it changed that
// ship in a later PR: a base older than the file reads as unchanged on the next
// update and moves on, while a base newer than the file would hide the change for good. A path
// that record lacks loses its base, so the next update adds it again. The text each path had is
// also kept under `held`, which planUpdate uses as the base once the repo holds exactly that text.
export function keepBase(root, paths) {
  const bad = paths.filter((p) => !safe(p));
  if (bad.length) throw new Error(`Refusing paths outside the repo: ${bad.join(", ")}`);
  const current = reader(root)(PRISTINE);
  if (current === null) throw new Error(`${PRISTINE} is missing: this repo was not set up with /bindwright:setup`);
  const saved = beforePath(root);
  const previous = saved === null ? null : readState(saved, "the record the last update replaced");
  if (previous === null) throw new Error("No record from before the last update: run /bindwright:update first");
  const what = "the record the last update replaced";
  const before = recordOf(decode(previous, what).replace(/\r\n/g, "\n"), what);
  const read = reader(root);
  const state = recordOf(current, PRISTINE);
  const result = { kept: [], dropped: [] };
  const files = new Map(Object.entries(state.files));
  const held = new Map(Object.entries(isObject(state.held) ? state.held : {}));
  for (const path of paths) {
    // Only the first hold counts: a repeat would read the base already put back.
    if (files.has(path) && !held.has(path)) held.set(path, files.get(path));
    // The base the last update decided against: that record's held text when the repo still
    // holds it, since a file shipped after an earlier hold has moved past the record's base. A
    // copy still at the text the update wrote (now held) is not restored yet, so it takes the record's.
    const ours = read(path);
    const prior = ours === held.get(path) ? before.files[path] : baseFor(before, path, ours);
    if (typeof prior === "string" && (prior === ours || Object.hasOwn(before.files, path))) {
      files.set(path, prior);
      result.kept.push(path);
    } else {
      files.delete(path);
      result.dropped.push(path);
    }
  }
  // Sorted as planUpdate writes them, so a base put back lands at its place, not at the end.
  state.files = sortedObject(files);
  if (held.size) state.held = sortedObject(held);
  else delete state.held;
  refuseLinks(root, [PRISTINE]);
  put(root, PRISTINE, stateJson(state));
  return result;
}

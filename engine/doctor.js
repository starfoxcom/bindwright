// /bindwright:doctor's engine step: a read-only health check of a set-up repo
// and this machine. Each check says what it found and, when something is
// wrong, the fix in plain words. Node only; doctor.py is the Python twin.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { ANSWERS, PRISTINE, STAGING } from "./bind.js";
import { expandAnswers, validate } from "./model.js";
import { MODS, commandHooks, isMissing, programOf, readLayerFile, runSettings } from "./layers.js";
import { decode } from "./update.js";

// What to do about each finding, in plain words.
const FIX = {
  restore: "Restore it from git with `git checkout -- .bindwright/`, or set the repo up again.",
  update: "Run /bindwright:update: it keeps the repo's own edits.",
  plugin: "Update the Bindwright plugin from /plugin first. Until then, do not run /bindwright:update: "
    + "it would write this older plugin's files.",
  reinstall: "Reinstall the Bindwright plugin from /plugin.",
  guards: "Restore them from git with `git checkout -- .claude/hooks/`; an update does not bring back deleted files.",
  settings: "Fix or remove those values in the files named.",
  join: "Run /bindwright:join: it installs each one on a yes and remembers a no.",
  cli: "Update the CLI. In Claude Desktop, update the app: it ships its own copy of the CLI.",
  staged: "Run /bindwright:update, which walks through each one, or delete the ones you do not want.",
  unreadable: "Fix or remove the file it names.",
  roadmap: "Fix those lines: each item is one line that starts with its id (R4), at most five sit under Now, "
    + "and the Next id line is above every id in use.",
  hooks: "Run /bindwright:setup again to reinstall them, "
    + "or fix the paths in the settings file named.",
  instructions: "Move what a session needs only for some files into rules with a `paths:` line, which load "
    + "only when Claude reads a matching file, or into the skill that uses it. Past the limit Claude Code "
    + "warns at every session start.",
};

// Claude Code's limit on the instruction files it loads at session start, in
// characters, and the share of it past which the doctor warns.
const INSTRUCTIONS_LIMIT = 150000;
const INSTRUCTIONS_WARN_AT = 120000;

// The first CLI with mods; older ones load none of them.
export const MODS_SINCE = [2, 1, 287];
// The first CLI that honours a hook's `onFailure: block`; on older ones a guard that crashes or
// runs out of time lets the command through.
export const GUARDS_SINCE = [2, 1, 295];

// "claude-code_2-1-286_agent", the variable the CLI sets for what it runs,
// as [2, 1, 286]; null when unknown. Read from the session, not from PATH,
// since Claude Desktop runs its own copy of the CLI.
export function cliVersionFrom(agent) {
  const m = /^claude-code_(\d+)-(\d+)-(\d+)_/.exec(typeof agent === "string" ? agent : "");
  return m ? m.slice(1).map(Number) : null;
}

const before = (a, b) => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i !== -1 && a[i] < b[i];
};

const parts = (v) => (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);

// Every file still waiting under .bindwright/incoming/, as repo paths.
function staged(root) {
  const base = join(root, ...STAGING.split("/").filter(Boolean));
  const out = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  if (existsSync(base)) walk(base, "");
  return out;
}

const check = (id, ok, say, fix = null) => ({ id, ok, say, fix });

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The state files: present, readable, and the answers valid.
function stateChecks(root) {
  const at = (path) => join(root, ...path.split("/"));
  let answers;
  let pristine;
  try {
    answers = readLayerFile(at(ANSWERS), ANSWERS);
    pristine = readLayerFile(at(PRISTINE), PRISTINE);
  } catch (err) {
    return { checks: [check("state", false, `A Bindwright state file cannot be read: ${err.message}.`,
      FIX.restore)] };
  }
  if (answers === null || pristine === null) {
    return { checks: [check("state", false, "This repo is not set up with Bindwright.", "Run /bindwright:setup.")] };
  }
  try {
    validate(expandAnswers(answers));
  } catch (err) {
    return { checks: [check("state", false, `The saved answers in ${ANSWERS} are broken: ${err.message}.`,
      `Restore the file from git with \`git checkout -- ${ANSWERS}\`.`)] };
  }
  const shaped = isObject(pristine) && isObject(pristine.files);
  if (!shaped) {
    return { checks: [check("state", false, `${PRISTINE} does not hold the files setup wrote.`,
      `Restore the file from git with \`git checkout -- ${PRISTINE}\`.`)] };
  }
  return { checks: [check("state", true, "The setup files are present and readable.")], answers, pristine };
}

function versionCheck(pristine, pluginVersion) {
  const [repo, plugin] = [parts(pristine.version), parts(pluginVersion)];
  if (!repo) return check("version", false, `${PRISTINE} names no version Bindwright can read.`, FIX.restore);
  if (!plugin) return check("version", false, "The plugin's own version cannot be read.", FIX.reinstall);
  const say = `The repo's Bindwright files come from ${pristine.version}; the plugin is ${pluginVersion}.`;
  if (before(repo, plugin)) return check("version", false, say, FIX.update);
  if (before(plugin, repo)) return check("version", false, say, FIX.plugin);
  return check("version", true, "The repo's files match the plugin's version.");
}

function guardCheck(root, answers, pristine) {
  const guards = [".claude/hooks/push-guard.py", ".claude/hooks/run-hook.sh"];
  const missing = answers.advanced.hookLocation === "repo"
    ? guards.filter((p) => Object.hasOwn(pristine.files, p) && !existsSync(join(root, ...p.split("/"))))
    : [];
  if (missing.length) {
    const say = `The repo's guard hooks are missing: ${missing.join(", ")}. Force pushes are not blocked here.`;
    return check("guards", false, say,
      FIX.guards);
  }
  return check("guards", true, "The guard hooks are in place.");
}

function settingsChecks(root, config) {
  let settings;
  try {
    settings = runSettings(root, config);
  } catch (err) {
    const say = `The settings cannot be read: ${err.message}.`;
    return { checks: [check("settings", false, say, FIX.unreadable)], installed: {} };
  }
  const out = [settings.ignored.length
    ? check("settings", false, `Some settings are not used: ${settings.ignored.join("; ")}.`, FIX.settings)
    : check("settings", true, "Every setting is in use.")];
  out.push(settings.drift.length
    ? check("extras", false, `The project expects extras this machine lacks: ${settings.drift.join(", ")}.`,
      FIX.join)
    : check("extras", true, "This machine has the extras the project expects."));
  return { checks: out, installed: settings.installed };
}

// Whether guard hooks run here: the repo's own, or the push or attribution guard in <config>.
function hasGuards(answers, pristine, installed) {
  const inRepo = answers.advanced.hookLocation === "repo"
    && Object.hasOwn(pristine.files, ".claude/hooks/run-hook.sh");
  return inRepo || Boolean(installed["push-guard"] || installed["attribution-guard"]);
}

function cliCheck(installed, cliVersion, guards) {
  const mods = Object.entries(installed ?? {}).some(([name, has]) => has && MODS.includes(name));
  const oldForMods = mods && before(cliVersion ?? MODS_SINCE, MODS_SINCE);
  const oldForGuards = guards && before(cliVersion ?? GUARDS_SINCE, GUARDS_SINCE);
  if (!oldForMods && !oldForGuards) return check("cli", true, "The CLI runs the guard hooks and the installed mods.");
  const needs = [oldForGuards && `the ${GUARDS_SINCE.join(".")} the guard hooks need, so a guard that crashes `
    + "or runs out of time lets the command through", oldForMods && `the ${MODS_SINCE.join(".")} the mods need, `
    + "so none of them load"].filter(Boolean);
  return check("cli", false, `This session runs CLI ${cliVersion.join(".")}, older than ${needs.join(", and ")}.`,
    FIX.cli);
}

// A staging folder that cannot be read is a finding, not a crash: the doctor
// is what explains a broken repo.
function stagedCheck(root) {
  let files;
  try {
    files = staged(root);
  } catch {
    return check("staged", false, `${STAGING} cannot be read as a folder.`, FIX.unreadable);
  }
  return files.length
    ? check("staged", false, `${files.length} staged file(s) wait under ${STAGING}: ${files.join(", ")}.`, FIX.staged)
    : check("staged", true, "No staged files are waiting.");
}

// What breaks the ROADMAP.md shape /close-session keeps: items are one line
// that starts with an unused id, at most five sit under Now, and the Next id
// is above every id in use. A missing file is fine; the next close writes it.
export function roadmapProblems(text) {
  const problems = [];
  const ids = new Set();
  let section = null;
  let now = 0;
  let next = null;
  // Plain string tests and trim(), never \s, \S or ".": those classes differ
  // between the twins. Ids stop at nine digits so both compare exact numbers.
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    const counter = /^Next id: R([0-9]{1,9}) *$/.exec(line);
    if (counter) next = Number(counter[1]);
    if (!line.startsWith("- ") || !["Now", "Next", "Later"].includes(section)) continue;
    const found = /^- R([0-9]{1,9}) /.exec(line);
    const item = found && line.slice(found[0].length).trim() ? found : null;
    if (!item) problems.push(`"${Array.from(line).slice(0, 60).join("")}" has no id`);
    else if (ids.has(item[1])) problems.push(`R${item[1]} is used twice`);
    else ids.add(item[1]);
    if (section === "Now") now++;
  }
  if (now > 5) problems.push(`${now} items sit under Now, more than five`);
  if (next === null) problems.push("the Next id line is missing");
  else if ([...ids].some((id) => Number(id) >= next)) problems.push(`Next id R${next} is not above every id in use`);
  return problems;
}

function roadmapCheck(root) {
  const file = join(root, "ROADMAP.md");
  if (!existsSync(file)) return check("roadmap", true, "No ROADMAP.md yet; the next /close-session writes it.");
  let problems;
  try {
    problems = roadmapProblems(decode(readFileSync(file), "ROADMAP.md"));
  } catch {
    return check("roadmap", false, "ROADMAP.md cannot be read.", FIX.unreadable);
  }
  return problems.length
    ? check("roadmap", false, `ROADMAP.md is out of shape: ${problems.join("; ")}.`, FIX.roadmap)
    : check("roadmap", true, "ROADMAP.md is in shape.");
}

// Every program a command hook in the config folder's settings.json starts.
function hooksCheck(config) {
  let settings;
  try {
    settings = readLayerFile(join(config, "settings.json"), "settings.json");
  } catch {
    return check("hooks", true, "Every hook's program is on this computer.");
  }
  const missing = [];
  for (const hook of commandHooks(settings)) {
    const program = programOf(hook);
    if (program !== null && !missing.includes(program) && isMissing(program)) missing.push(program);
  }
  return missing.length
    ? check("hooks", false, "Some hooks start a program this computer does not have: "
      + `${missing.join(", ")}. Those hooks fail on every call.`, FIX.hooks)
    : check("hooks", true, "Every hook's program is on this computer.");
}

// An empty list, an empty string and YAML's null forms list no path.
const EMPTY_YAML = /^(?:\[[ \t]*\]|""|''|~|null|Null|NULL)$/;

// A rule whose front matter lists at least one path under `paths:` loads only
// when Claude reads a file it matches, so it is not loaded at session start.
function isPathScoped(text) {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  // Front matter that never closes is no front matter, so the whole file loads.
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1) return false;
  for (let i = 1; i < end; i++) {
    if (!lines[i].startsWith("paths:")) continue;
    const rest = lines[i].slice("paths:".length);
    const comment = rest.search(/(^|[ \t])#/);
    const inline = (comment === -1 ? rest : rest.slice(0, comment)).trim();
    if (inline) return !EMPTY_YAML.test(inline);
    const next = lines.slice(i + 1).find((line) => line.trim() && !line.trim().startsWith("#"));
    return (next ?? "").trim().startsWith("- ");
  }
  return false;
}

// A file's or folder's identity on its disk, the same however a path spells it
// (case, links, short names). A disk that numbers no files reports inode 0, so
// there its canonical path stands in. Null when it cannot be read.
function fileId(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.ino === 0n ? `path:${canonicalPath(path)}` : `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

// On Windows, the name Windows itself gives a path (case as on disk, long
// names), as Python's realpath asks for it; elsewhere, or where Windows cannot
// say, the path with its links resolved one by one.
function canonicalPath(path) {
  if (process.platform === "win32") {
    try {
      return realpathSync.native(path);
    } catch {
      // Some network and user-mode file systems refuse the call.
    }
  }
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Each Markdown file under `dir`, sorted, as [path below `dir`, full path],
// links followed as Claude Code follows them; a folder already walked is
// skipped, so a link back up the tree ends. Empty when the folder cannot be read.
function markdownFiles(dir, prefix = "", seen = new Set()) {
  const id = fileId(dir);
  if (id === null || seen.has(id)) return [];
  seen.add(id);
  let names;
  try {
    names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return [];
    }
    if (stat.isDirectory()) return markdownFiles(path, `${prefix}${name}/`, seen);
    return stat.isFile() && name.endsWith(".md") ? [[`${prefix}${name}`, path]] : [];
  });
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// The instruction files Claude Code loads at session start for this repo and
// config folder, as [name, characters in UTF-16 units, as Claude Code counts
// them, whether it comes from ~/.claude]: each CLAUDE.md and every rule without
// a `paths:` list. A rule in the config folder (wherever the walk reached it
// from) is named only as such, so its file name never reaches a bug report, and
// a file reached twice counts once. A CLAUDE.md above the repo and files it
// imports are not counted.
function startFiles(root, config) {
  const out = [];
  const counted = new Set();
  // `rule` is null for a CLAUDE.md, "repo" for a rule the repo's folder holds, "personal" for one in ~/.claude.
  // The personal rules are walked first, so a file both folders reach counts once, under the personal name.
  const add = (name, path, rule = null, personal = false) => {
    const id = fileId(path);
    const text = id === null || counted.has(id) ? null : readText(path);
    if (text === null || (rule && isPathScoped(text))) return;
    counted.add(id);
    out.push([rule === "personal" ? "a rule in ~/.claude/rules" : name, text.length, personal]);
  };
  for (const name of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) add(name, join(root, ...name.split("/")));
  add("~/.claude/CLAUDE.md", join(config, "CLAUDE.md"), null, true);
  for (const [name, path] of markdownFiles(join(config, "rules"))) {
    add(name, path, "personal", true);
  }
  for (const [name, path] of markdownFiles(join(root, ".claude", "rules"))) add(`.claude/rules/${name}`, path, "repo");
  return out;
}

// Characters as thousands with one decimal, cut rather than rounded, so both engines print the same.
const kilo = (n) => `${Math.floor(n / 1000)}.${Math.floor((n % 1000) / 100)}k`;

const sumSizes = (files) => files.reduce((sum, [, size]) => sum + size, 0);

// Auto memory's index, MEMORY.md, loaded at session start beside the instruction files.
const MEMORY_LINES = 200;
// The 25KB limit is read as 25,000 bytes.
const MEMORY_BYTES = 25000;

// The text's first `count` lines, each keeping its line ending.
function firstLines(text, count) {
  let end = 0;
  for (let i = 0; i < count; i++) {
    const newline = text.indexOf("\n", end);
    if (newline === -1) return text;
    end = newline + 1;
  }
  return text.slice(0, end);
}

// The first `limit` bytes, backing up so that no character is cut in two.
function firstBytes(bytes, limit) {
  let cut = Math.min(bytes.length, limit);
  while (cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut);
}

// What Claude Code keeps of the index as UTF-16 units, and whether the file is past either limit.
function loadedIndex(bytes) {
  const text = bytes.toString("utf8");
  const head = firstLines(text, MEMORY_LINES);
  const kept = firstBytes(Buffer.from(head, "utf8"), MEMORY_BYTES).toString("utf8");
  // `kept` is always a start of `text`, so one test covers both cuts.
  return { units: kept.length, past: kept.length < text.length };
}

// The sentence about the index at `index`, the path the session says Claude Code loaded it from,
// or "" when no path is given or the file cannot be read. The path is taken, never worked out:
// Claude Code's own naming of the memory folder is not documented in full.
function memoryNote(index) {
  if (!index) return "";
  let bytes;
  try {
    bytes = readFileSync(index);
  } catch {
    return "";
  }
  const { units, past } = loadedIndex(bytes);
  const sentence = `Auto memory's index (MEMORY.md) adds ${kilo(units)} more.`;
  return past
    ? `${sentence} It is past the 200 lines or 25KB Claude Code loads, `
      + "so the rest of it never reaches a session."
    : sentence;
}

function instructionsCheck(root, config, memoryIndex) {
  const files = startFiles(root, config);
  const total = sumSizes(files);
  const personal = sumSizes(files.filter(([, , fromPersonal]) => fromPersonal));
  const largest = [...files].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 3);
  const listed = largest.map(([name, size]) => `${name} (${kilo(size)})`).join(", ") || "none";
  const note = memoryNote(memoryIndex);
  const say = `Claude Code loads ${files.length} instruction files at session start, ${kilo(total)} characters `
    + `of its ${kilo(INSTRUCTIONS_LIMIT)} limit. ${kilo(total - personal)} of it from this repo `
    + `and ${kilo(personal)} from ~/.claude. The largest: ${listed}.${note ? ` ${note}` : ""}`;
  return total < INSTRUCTIONS_WARN_AT ? check("instructions", true, say) : check("instructions", false, say,
    FIX.instructions);
}

// Every check for the repo at `root` and the config folder `config`.
// `pluginVersion` is "x.y.z"; `cliVersion` [major, minor, patch] or null; `memoryIndex` the
// auto-memory index the session loaded, or undefined.
export function runDoctor(root, config, { pluginVersion, cliVersion, memoryIndex }) {
  const state = stateChecks(root);
  const checks = [...state.checks, hooksCheck(config)];
  if (state.answers) {
    checks.push(versionCheck(state.pristine, pluginVersion), guardCheck(root, state.answers, state.pristine));
    checks.push(stagedCheck(root), instructionsCheck(root, config, memoryIndex));
    if (state.answers.advanced.tracker === "file") checks.push(roadmapCheck(root));
    const settings = settingsChecks(root, config);
    const guards = hasGuards(state.answers, state.pristine, settings.installed);
    checks.push(...settings.checks, cliCheck(settings.installed, cliVersion, guards));
  }
  return { problems: checks.filter((c) => !c.ok).length, checks };
}

// The three settings layers of docs/v2/HANDOFF.md, lowest first: personal
// (<config>/bindwright/settings.json), the project (.bindwright/project.json,
// committed) and personal-in-this-project (.bindwright/local.json, never
// committed). A later layer wins, except where the project requires a value.
// Every layer is data only: an unknown key or a bad value is listed in
// `ignored`, never applied, and a file from a newer Bindwright is refused.
// Keys are read in sorted order, so both twins list them alike.
// Node only; layers.py is the Python twin.

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { CODE_RESEARCH_TOOLS, TRACKERS, mapRemovedTool } from "./model.js";
import { MAX_DEPTH, depthOf } from "./setupcode.js";
import { ANSWERS } from "./bind.js";
import { decode, readState } from "./update.js";

export const SCHEMA = 1;
export const LOCAL = ".bindwright/local.json";
export const PERSONAL = "bindwright/settings.json";

// The extras setup offers for ~/.claude, each with the file under the config
// folder that shows it is installed. A mod's file is its folder under mods/.
const EXTRA_FILES = {
  "attribution-guard": "hooks/no-ai-attribution.py",
  "builder": "agents/builder.md",
  "code-style": "rules/code-style.md",
  "global-instructions": "CLAUDE.md",
  "push-guard": "hooks/push-guard.py",
  "reply-style": "output-styles/straight-talk.md",
  "session-title": "hooks/session-title.py",
};
// An extra whose file is the person's own (CLAUDE.md) counts as installed only
// when that file holds its marker on a line of its own, spaces and tabs aside.
export const MARKERS = {
  "global-instructions": "<!-- bindwright:global-instructions -->",
};
// The extras that are a value in the config folder's settings.json, not a file.
const SETTING_EXTRAS = {
  "plugin-auto-update": (settings) => {
    const entry = settings.extraKnownMarketplaces?.wrights;
    return entry !== null && typeof entry === "object" && entry.autoUpdate === true;
  },
};
export const MODS = [
  "chat-sync", "ci-watch", "compact-handoff", "mods", "runners", "session-facts",
  "session-info", "shared-pc", "skill-check", "tasks", "usage-guard",
];
export const EXTRAS = [...Object.keys(EXTRA_FILES), ...Object.keys(SETTING_EXTRAS), ...MODS].sort();
const LEVELS = ["required", "recommended"];
// The work languages a personal layer may pick; home.py keeps the same list.
export const LANGUAGES = ["english", "spanish"];

const own = (obj, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const asObject = (v) => (isObject(v) ? v : {});
const asList = (v) => (Array.isArray(v) ? v : []);

// The settings a layer may hold, each with its test for a valid value.
export const SETTINGS = {
  codeResearch: (v) => own(CODE_RESEARCH_TOOLS, v),
  language: (v) => typeof v === "string" && LANGUAGES.includes(v),
  tracker: (v) => typeof v === "string" && TRACKERS.includes(v),
};

// The custom tool needs the name and URL only the project's answers carry,
// so a personal layer cannot pick it.
const personalOnlyBad = (key, value) => key === "codeResearch" && value === "custom";

// Refuses a file from a newer Bindwright, or one whose version is not a whole number.
function checkSchema(schema, file) {
  if (schema === undefined) return;
  if (!Number.isInteger(schema) || schema < 1) throw new Error(`${file} has no valid schema number`);
  if (schema > SCHEMA) throw new Error(`${file} was written by a newer Bindwright: update the plugin`);
}

// A setting extra applies only on some computers (a wrights install), so a project cannot rate it.
const RATEABLE = EXTRAS.filter((extra) => !own(SETTING_EXTRAS, extra));

function readExtras(extras, name, isValid, ignored, names = EXTRAS) {
  const out = {};
  if (extras === undefined) return out;
  if (!isObject(extras)) {
    ignored.push(`${name}: extras`);
    return out;
  }
  for (const extra of Object.keys(extras).sort()) {
    const value = extras[extra];
    if (names.includes(extra) && isValid(value)) out[extra] = value;
    else ignored.push(`${name}: extras.${extra}`);
  }
  return out;
}

// A personal layer: { schema, codeResearch, language, tracker, extras: { <extra>: true | false } }.
function readPersonal(raw, name, file) {
  const layer = { settings: {}, extras: {}, required: [], ignored: [] };
  if (raw === null) return layer;
  if (!isObject(raw)) throw new Error(`${file} must hold a JSON object`);
  checkSchema(raw.schema, file);
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (key === "schema") continue;
    if (key === "extras") layer.extras = readExtras(value, name, (v) => typeof v === "boolean", layer.ignored);
    else if (own(SETTINGS, key) && SETTINGS[key](value) && !personalOnlyBad(key, value)) layer.settings[key] = value;
    else layer.ignored.push(`${name}: ${key}`);
  }
  return layer;
}

// The project layer: the answers' own choices, plus the `setup` object
// /bindwright:export writes: { schema, extras: { <extra>: "required" |
// "recommended" }, required: [<setting>, ...] }.
function readProject(answers) {
  const layer = { settings: {}, extras: {}, required: [], ignored: [] };
  if (answers === null) return layer;
  if (!isObject(answers)) throw new Error(`${ANSWERS} must hold a JSON object`);
  // A removed tool reads as custom, as expandAnswers reads a saved answers file.
  const advanced = mapRemovedTool(isObject(answers.advanced) ? answers.advanced : {});
  for (const key of Object.keys(SETTINGS)) {
    if (SETTINGS[key](advanced[key])) layer.settings[key] = advanced[key];
  }
  const setup = answers.setup;
  if (setup === undefined) return layer;
  if (!isObject(setup)) {
    layer.ignored.push("project: setup");
    return layer;
  }
  checkSchema(setup.schema, `${ANSWERS} (setup)`);
  for (const key of Object.keys(setup).sort()) {
    const value = setup[key];
    if (key === "schema") continue;
    if (key === "extras") {
      layer.extras = readExtras(value, "project", (v) => LEVELS.includes(v), layer.ignored, RATEABLE);
    }
    else if (key === "required" && Array.isArray(value)) {
      for (const item of value) {
        if (own(SETTINGS, item) && own(layer.settings, item)) layer.required.push(item);
        else layer.ignored.push(typeof item === "string" ? `project: required.${item}` : "project: required");
      }
    } else layer.ignored.push(`project: setup.${key}`);
  }
  return layer;
}

// One setting across the layers: the project's value when it requires one,
// else the highest layer that sets it. A lower value it overrides is noted.
function resolveSetting(key, { personal, project, local }, ignored) {
  const required = project.required.includes(key);
  if (required) {
    for (const [name, layer] of [["personal", personal], ["local", local]]) {
      const value = layer.settings[key];
      const overridden = value !== undefined && value !== project.settings[key];
      if (overridden) ignored.push(`${name}: ${key} (the project requires it)`);
    }
    return { value: project.settings[key], from: "project", required };
  }
  for (const [name, layer] of [["local", local], ["project", project], ["personal", personal]]) {
    if (own(layer.settings, key)) return { value: layer.settings[key], from: name, required };
  }
  return null;
}

// One extra: whether the person wants it, and how the project rates it.
// `want` is null while nobody has decided, which /bindwright:join asks about.
function resolveExtra(extra, { personal, project, local }, ignored) {
  const level = project.extras[extra] ?? null;
  if (level === "required") {
    for (const [name, layer] of [["personal", personal], ["local", local]]) {
      if (layer.extras[extra] === false) ignored.push(`${name}: extras.${extra} (the project requires it)`);
    }
    return { project: level, want: true, from: "project" };
  }
  for (const [name, layer] of [["local", local], ["personal", personal]]) {
    if (own(layer.extras, extra)) return { project: level, want: layer.extras[extra], from: name };
  }
  return level === null ? null : { project: level, want: null, from: null };
}

// The layers resolved: { settings, extras, ignored }. Each argument is a
// parsed file or null when it is missing.
export function resolveLayers({ personal = null, project = null, local = null }) {
  const layers = {
    personal: readPersonal(personal, "personal", PERSONAL),
    project: readProject(project),
    local: readPersonal(local, "local", LOCAL),
  };
  const ignored = [...layers.personal.ignored, ...layers.project.ignored, ...layers.local.ignored];
  const settings = {};
  for (const key of Object.keys(SETTINGS)) {
    const resolved = resolveSetting(key, layers, ignored);
    if (resolved) settings[key] = resolved;
  }
  const extras = {};
  for (const extra of EXTRAS) {
    const resolved = resolveExtra(extra, layers, ignored);
    if (resolved) extras[extra] = resolved;
  }
  return { settings, extras, ignored };
}

// Whether the file holds the marker on a line of its own. A file that cannot be
// read as UTF-8, or cannot be read at all, does not hold it.
function hasMarker(path, marker) {
  let text;
  try {
    text = decode(readFileSync(path), path);
  } catch {
    return false;
  }
  return text.split("\n").some((line) => line.replace(/^[ \t\r]+|[ \t\r]+$/g, "") === marker);
}

// The command hooks under every event of a settings file, in file order.
export function commandHooks(settings) {
  const hooks = [];
  for (const entries of Object.values(asObject(asObject(settings).hooks))) {
    for (const entry of asList(entries)) {
      for (const hook of asList(asObject(entry).hooks)) {
        if (isObject(hook) && hook.type === "command") hooks.push(hook);
      }
    }
  }
  return hooks;
}

function firstWord(command) {
  const text = command.trim();
  if (text.startsWith('"') || text.startsWith("'")) return text.slice(1).split(text[0], 1)[0];
  return text.split(" ", 1)[0];
}

// The program a command hook starts, or null when it is not judged.
export function programOf(hook) {
  if (typeof hook.command !== "string") return null;
  let program = hook.command;
  if (!("args" in hook)) {
    // A shell line may open with a builtin or an assignment (`cd dir && tool`), so only a path is judged.
    program = firstWord(program);
    if (!isAbsolute(program)) return null;
  }
  return program && !program.includes("$") && !program.includes("%") ? program : null;
}

// Windows runs a name with a PATHEXT suffix, unless the name already has one.
// Empty entries are skipped and an unset PATHEXT takes Windows' default list; layers.py runs the same lookup.
function withPathext(name) {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC").split(";").filter(Boolean);
  if (exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()))) return [name];
  return exts.map((ext) => name + ext);
}

// A file, and executable on POSIX: what the shell would run.
function isRunnable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name) {
  const names = process.platform === "win32" ? withPathext(name) : [name];
  const dirs = (process.env.PATH ?? "").split(delimiter);
  return dirs.some((dir) => names.some((n) => isRunnable(join(dir, n))));
}

// A path must exist and a bare name must be on PATH; any other program is not judged.
export function isMissing(program) {
  if (isAbsolute(program)) return !existsSync(program);
  if (program.includes("/") || program.includes("\\")) return false;
  return !onPath(program);
}

// The .py file names a hook's command or args run, read as home.py's list-hooks reads them.
function hookFiles(hook) {
  return [hook.command, ...asList(hook.args)]
    .filter((word) => typeof word === "string")
    .map((word) => word.replace(/\\/g, "/").replace(/^["']+|["']+$/g, ""))
    .filter((word) => word.endsWith(".py"))
    .map((word) => word.split("/").pop());
}

// Whether a command hook in the config folder's settings.json runs the named file with a
// program this computer has, or one that cannot be judged (a `$VAR` in it).
function hookRuns(config, name) {
  let settings;
  try {
    settings = readLayerFile(join(config, "settings.json"), "settings.json");
  } catch {
    return false;
  }
  return commandHooks(settings).some((hook) => {
    if (!hookFiles(hook).includes(name)) return false;
    const program = programOf(hook);
    return program === null || !isMissing(program);
  });
}

// Whether a setting extra's value holds in the config folder's settings.json.
function settingHolds(config, extra) {
  let settings;
  try {
    settings = readLayerFile(join(config, "settings.json"), "settings.json");
  } catch {
    return false;
  }
  return settings !== null && typeof settings === "object" && SETTING_EXTRAS[extra](settings);
}

// The extras present under the config folder (~/.claude), by name.
export function installedExtras(config) {
  const at = (extra) => (own(EXTRA_FILES, extra) ? EXTRA_FILES[extra] : `mods/${extra}`);
  const present = (extra) => {
    if (own(SETTING_EXTRAS, extra)) return settingHolds(config, extra);
    const file = at(extra);
    const path = join(config, ...file.split("/"));
    if (own(MARKERS, extra)) return hasMarker(path, MARKERS[extra]);
    // A guard whose entry was deleted, or whose program is gone, counts as missing so setup installs it again.
    if (/^hooks\/[^/]+\.py$/.test(file)) return existsSync(path) && hookRuns(config, file.slice("hooks/".length));
    return existsSync(path);
  };
  return Object.fromEntries(EXTRAS.map((extra) => [extra, present(extra)]));
}

// A settings file's text, or null when it is missing.
export function readLayerText(path, file) {
  const bytes = readState(path, file);
  return bytes === null ? null : decode(bytes, file);
}

// The JSON in a settings file's text.
export function parseLayerText(text, file) {
  if (depthOf(text) > MAX_DEPTH) throw new Error(`${file} nests too deeply`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

// A settings file's JSON, or null when it is missing.
export function readLayerFile(path, file) {
  const text = readLayerText(path, file);
  return text === null ? null : parseLayerText(text, file);
}

// Refuses a project.json that the two engines would rewrite differently: a
// number other than a plain whole number of up to 15 digits (JSON.stringify
// and json.dumps spell 1.0, 1e400, -0 and long integers differently), or a key
// that is a canonical array index, which JavaScript moves to the front of an
// object. Scans the raw text outside strings, so a string value is never read as a number.
const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?[0-9][-+.eE0-9]*)/g;
const PLAIN_INTEGER = /^(0|-?[1-9][0-9]{0,14})$/;
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

const unstable = (what) =>
  new Error(`${ANSWERS} holds ${what} that the two engines would write differently; ` +
    "edit it by hand first");

export function refuseUnstableJson(text) {
  for (const [, quoted, colon, number] of text.matchAll(JSON_TOKEN)) {
    if (number !== undefined && !PLAIN_INTEGER.test(number)) throw unstable(`the number ${number}`);
    if (colon === undefined) continue;
    const key = JSON.parse(quoted);
    if (ARRAY_INDEX.test(key)) throw unstable(`the key "${key}"`);
  }
}

// The resolved settings of the repo at `root` for the person whose config
// folder is `config`, with which extras are installed and `drift`: the
// extras the project rates that this machine lacks and nobody declined.
export function runSettings(root, config) {
  const at = (path) => join(root, ...path.split("/"));
  const resolved = resolveLayers({
    personal: readLayerFile(join(config, ...PERSONAL.split("/")), PERSONAL),
    project: readLayerFile(at(ANSWERS), ANSWERS),
    local: readLayerFile(at(LOCAL), LOCAL),
  });
  const installed = installedExtras(config);
  const drift = Object.entries(resolved.extras)
    .filter(([extra, e]) => e.project !== null && e.want !== false && !installed[extra])
    .map(([extra]) => extra);
  return { ...resolved, installed, drift };
}

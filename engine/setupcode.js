// The setup code the page hands to /bindwright:setup: "bw1-" followed by the
// answers as UTF-8 JSON in base64url without padding. A code carries the three
// answers plus only the project and advanced values that differ from the
// defaults; expandAnswers (model.js) fills the rest. The Python twin
// (setupcode.py) decodes it with the same checks and messages.

import { defaults } from "./model.js";

export const PREFIX = "bw1-";
// Real answers encode to about 1 KB and nest three levels deep. The caps keep
// a huge code from reaching the JSON reader, and a deep one from Python's,
// which gives up near 1000 levels where JSON.parse keeps going.
const MAX_BODY = 20000;
export const MAX_DEPTH = 64;

function fail(msg) {
  throw new Error(`Invalid setup code: ${msg}`);
}

// The deepest bracket nesting outside JSON strings.
export function depthOf(text) {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;
  for (const c of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") deepest = Math.max(deepest, ++depth);
    else if (c === "]" || c === "}") depth--;
  }
  return deepest;
}

const isObjectLike = (x) => x !== null && typeof x === "object";

// Deep equality for the JSON values answers hold.
function same(a, b) {
  if (a === b) return true;
  if (!isObjectLike(a) || !isObjectLike(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

// The keys of `part` whose values differ from the default part's.
function changedKeys(part, dflt) {
  const diff = {};
  for (const [key, value] of Object.entries(part)) {
    if (!same(value, Object.hasOwn(dflt, key) ? dflt[key] : undefined)) diff[key] = value;
  }
  return diff;
}

// The three answers, and project and advanced only where something differs.
function compactAnswers(answers) {
  const base = defaults({ team: answers.team, client: answers.client, isPrivate: answers.private });
  const out = { team: answers.team, client: answers.client, private: answers.private };
  for (const part of ["project", "advanced"]) {
    const diff = changedKeys(answers[part], base[part]);
    if (Object.keys(diff).length > 0) out[part] = diff;
  }
  return out;
}

// The compact form unless `full` asks for every answer.
export function encodeSetupCode(answers, { full = false } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(full ? answers : compactAnswers(answers)));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A page-made answer set holds the same keys at every team, client and private
// combination, so any other key is refused: a code cannot carry text the setup
// did not choose. Checked here, not in validate, so saved project.json files
// that hold keys since dropped still load. The alphabetically first unknown key
// is named, so the Python twin names the same one.
function refuseUnknownKeys(answers) {
  const known = defaults();
  const levels = [["answer", answers, known], ["project answer", answers.project, known.project],
    ["advanced answer", answers.advanced, known.advanced]];
  for (const [label, part, dflt] of levels) {
    if (!isObjectLike(part) || Array.isArray(part)) continue;
    const unknown = Object.keys(part).filter((key) => !Object.hasOwn(dflt, key)).sort()[0];
    if (unknown !== undefined) fail(`unknown ${label} "${unknown}"`);
  }
}

// Free text is set inside the session, never carried in a code: the project
// strings must be empty and the custom tool and path values must be null.
function refuseFreeText(answers) {
  const isPlainObject = (x) => isObjectLike(x) && !Array.isArray(x);
  const { project, advanced } = answers;
  const carriesFreeText = (key) => key in project && project[key] !== "";
  if (isPlainObject(project) && ["repoUrl", "licenseHolder"].some(carriesFreeText)) {
    fail("the setup code carries a repoUrl or licenseHolder; setup asks for those in the session");
  }
  const carriesCustomText = (key) => advanced[key] !== undefined && advanced[key] !== null;
  if (isPlainObject(advanced) && ["codeResearchCustom", "shippedTextPaths"].some(carriesCustomText)) {
    fail("the setup code carries custom tool or path text; setup asks for those in the session");
  }
}

export function decodeSetupCode(code) {
  if (typeof code !== "string" || !code.startsWith(PREFIX)) fail(`it must start with ${PREFIX}`);
  const body = code.slice(PREFIX.length);
  if (body.length > MAX_BODY) fail("it is too long");
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) fail("the part after the prefix is not base64url");
  const binary = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    fail("it does not hold UTF-8 JSON");
  }
  if (depthOf(text) > MAX_DEPTH) fail("it nests too deeply");
  let answers;
  try {
    answers = JSON.parse(text);
  } catch {
    fail("it does not hold UTF-8 JSON");
  }
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) fail("the answers must be an object");
  refuseUnknownKeys(answers);
  refuseFreeText(answers);
  return answers;
}

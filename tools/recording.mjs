// Pure helpers for the recording harness: the freshness hashes, the answers a
// scenario binds with, and the replay of a headless session's stream-json
// events. tools/record.mjs does the spawning; nothing here starts a process.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { bind } from "../engine/bind.js";
import { defaults } from "../engine/model.js";
import { scrub } from "../engine/report.js";

const YEAR = 2026;
const EDIT_CUT = 800;
const INPUT_CUT = 300;
const OUTPUT_CUT = 1500;
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const head = (text, max) => Array.from(text).slice(0, max).join("");

// The text as it may appear in a recording: scrubbed, then the repo's
// folder name shown as the project's own name.
export function cleanText(text, who) {
  return scrub(text, who).replaceAll("<repo>", "splitbill");
}

const shown = (text, who, max) => head(cleanText(text, who), max);

// The answers a scenario binds with: the defaults, with the saved project and
// advanced parts merged over them.
export function scenarioAnswers(answers) {
  const base = defaults({ team: answers.team, client: answers.client, isPrivate: answers.private });
  return {
    ...base,
    project: { ...base.project, ...answers.project },
    advanced: { ...base.advanced, ...answers.advanced },
  };
}

// Hash of [path, text] entries. Entries are sorted by path, and CRLF is read
// as LF, so Windows and Linux checkouts give the same hash.
export function textHash(entries) {
  const hash = createHash("sha256");
  const byPath = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  for (const [path, text] of [...entries].sort(byPath)) {
    hash.update(`${path}\0${text.replace(/\r\n/g, "\n")}\0`);
  }
  return hash.digest("hex");
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

// Every file under <repo>/demo except node_modules, as [path, text] entries.
export function demoEntries(repo) {
  const root = join(repo, "demo");
  return filesUnder(root).map((file) => [
    `demo/${relative(root, file).split(sep).join("/")}`,
    readFileSync(file, "utf8"),
  ]);
}

// The full bind of the scenario answers: every file, .bindwright/ included.
export async function bindAll(repo, answers) {
  const readFile = async (path) => readFileSync(join(repo, path), "utf8");
  const coreFiles = JSON.parse(readFileSync(join(repo, "engine", "core-files.json"), "utf8"));
  const bound = await bind(scenarioAnswers(answers), { readFile, coreFiles, year: YEAR });
  return [...bound];
}

// The bind's files, leaving out the .bindwright/ working files.
export async function bindEntries(repo, answers) {
  return (await bindAll(repo, answers)).filter(([dest]) => !dest.startsWith(".bindwright/"));
}

// The hashes a recording was made from. "with" runs also hash the bind.
export async function exercisedFor(repo, scenario, variant, answers) {
  const exercised = {
    demo: textHash(demoEntries(repo)),
    scenario: sha256(JSON.stringify(scenario)),
  };
  if (variant === "with") exercised.bindwright = textHash(await bindEntries(repo, answers));
  return exercised;
}

// The keys whose hashes differ between a recording and the current inputs.
export function staleParts(recording, current) {
  const old = recording.exercised ?? {};
  const keys = new Set([...Object.keys(old), ...Object.keys(current)]);
  return [...keys].filter((key) => old[key] !== current[key]).sort();
}

const blocksOf = (event) => (Array.isArray(event?.message?.content) ? event.message.content : []);

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function outputOf(result, who) {
  const clean = cleanText(textOf(result?.content ?? ""), who);
  return Array.from(clean).length > OUTPUT_CUT ? `${head(clean, OUTPUT_CUT)}…` : clean;
}

function fileInput(name, input, who) {
  const file = cleanText(input.file_path ?? "", who);
  if (name !== "Edit") return file;
  return `${file}\n- ${shown(input.old_string ?? "", who, EDIT_CUT)}`
    + `\n+ ${shown(input.new_string ?? "", who, EDIT_CUT)}`;
}

function inputOf(name, input, who) {
  if (FILE_TOOLS.has(name)) return fileInput(name, input, who);
  if (SHELL_TOOLS.has(name)) return cleanText(input.command ?? "", who);
  if (SEARCH_TOOLS.has(name)) return cleanText(input.pattern ?? "", who);
  return shown(JSON.stringify(input), who, INPUT_CUT);
}

function toolTurn(block, result, who) {
  return {
    type: "tool",
    name: cleanText(block.name, who),
    input: inputOf(block.name, block.input ?? {}, who),
    output: outputOf(result, who),
    isError: result?.is_error === true,
  };
}

// The turns of a headless session, in order: what the agent said, and each
// tool it ran with the result that came back for it.
export function replayFrom(events, who) {
  const results = new Map();
  for (const event of events) {
    for (const block of blocksOf(event)) {
      if (block.type === "tool_result") results.set(block.tool_use_id, block);
    }
  }
  const turns = [];
  for (const event of events.filter((e) => e.type === "assistant")) {
    for (const block of blocksOf(event)) {
      if (block.type === "text" && block.text?.trim()) {
        turns.push({ type: "say", text: cleanText(block.text, who) });
      } else if (block.type === "tool_use") {
        turns.push(toolTurn(block, results.get(block.id), who));
      }
    }
  }
  return turns;
}

// Cost, turns, duration and error flag from the session's result event.
export function outcomeFrom(resultEvent) {
  return {
    costUsd: resultEvent?.total_cost_usd ?? null,
    turns: resultEvent?.num_turns ?? null,
    durationMs: resultEvent?.duration_ms ?? null,
    isError: resultEvent?.is_error ?? null,
  };
}

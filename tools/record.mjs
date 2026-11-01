// Records headless Claude Code runs on demo/, with and without Bindwright:
//   node tools/record.mjs <scenario-id|all> [with|without|both]
// Needs CLAUDE_CODE_OAUTH_TOKEN (made by `claude setup-token`) or
// ANTHROPIC_API_KEY in the environment; without either it exits 1.
// Each run costs money. Each scenario and variant writes
// recordings/<id>/<variant>.json, which engine/test/recordings.test.js checks.

import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFiles } from "../engine/apply.js";
import {
  bindAll, cleanText, exercisedFor, outcomeFrom, replayFrom,
} from "./recording.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDINGS = join(REPO, "recordings");
const VARIANTS = ["without", "with"];
const MAX_BUFFER = 64 * 1024 * 1024;
const AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const GIT_USER = ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid"];

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, ...options });
  if (result.status !== 0 && options?.check !== false) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

function commitAll(project, message) {
  run("git", ["add", "-A"], { cwd: project });
  run("git", [...GIT_USER, "commit", "-qm", message], { cwd: project });
}

function copyDemo(project) {
  cpSync(join(REPO, "demo"), project, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
  });
  run("git", ["init", "-q"], { cwd: project });
  commitAll(project, "start");
}

async function bindInto(project, answers) {
  applyFiles(await bindAll(REPO, answers), project);
  commitAll(project, "add Bindwright");
}

function claudeArgs(scenario) {
  return [
    "-p", scenario.prompt, "--output-format", "stream-json", "--verbose",
    "--model", scenario.model, "--max-turns", "40", "--max-budget-usd", "3",
    "--permission-mode", "acceptEdits", "--no-session-persistence",
    "--allowedTools", "Bash(node:*)", "Bash(npm:*)", "Bash(git:*)",
  ];
}

// The environment without this machine's own Claude setup, so both runs
// start from the same empty configuration.
function runEnv(configDir) {
  const kept = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC)/.test(name)),
  );
  const auth = Object.fromEntries(AUTH_VARS.filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]));
  return { ...kept, ...auth, CLAUDE_CONFIG_DIR: configDir };
}

function parseEvents(stdout) {
  return stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function runClaude(project, configDir, scenario) {
  const result = run("claude", claudeArgs(scenario), {
    cwd: project, env: runEnv(configDir), check: false,
  });
  return parseEvents(result.stdout);
}

function claudeVersion(configDir) {
  return run("claude", ["--version"], { env: runEnv(configDir), check: false }).stdout.trim();
}

// Paths the agent touched since `base`, committed or not, untracked included.
function changedPaths(project, base) {
  const diff = run("git", ["diff", "--name-only", base], { cwd: project }).stdout;
  const status = run("git", ["status", "--porcelain"], { cwd: project }).stdout;
  const untracked = status.split("\n").filter(Boolean).map((line) => line.slice(3));
  return [...new Set([...diff.split("\n"), ...untracked])].filter(Boolean);
}

function plantedLeft(project) {
  const planted = JSON.parse(readFileSync(join(REPO, "recordings", "planted.json"), "utf8"));
  return planted.planted
    .filter((p) => {
      const file = join(project, ...p.file.replace(/^demo\//, "").split("/"));
      return existsSync(file) && new RegExp(p.evidence).test(readFileSync(file, "utf8"));
    })
    .map((p) => p.id);
}

// Commits the agent made: the log minus the harness's own commits, oldest first.
function agentCommits(project, harnessCommits) {
  const subjects = run("git", ["log", "--format=%s"], { cwd: project }).stdout
    .split("\n").filter(Boolean);
  return subjects.slice(0, subjects.length - harnessCommits).reverse();
}

function outcomeOf(project, base, harnessCommits, who) {
  const tests = run(process.execPath, ["--test"], { cwd: project, check: false });
  return {
    testsPass: tests.status === 0,
    changed: changedPaths(project, base).map((path) => cleanText(path, who)),
    commits: agentCommits(project, harnessCommits).map((text) => cleanText(text, who)),
    plantedLeft: plantedLeft(project),
  };
}

function eventsOf(events, type) {
  return events.find((event) => event.type === type);
}

async function recordOne(scenario, variant, answers) {
  const project = mkdtempSync(join(tmpdir(), "rec-"));
  const configDir = mkdtempSync(join(tmpdir(), "rec-config-"));
  try {
    copyDemo(project);
    if (variant === "with") await bindInto(project, answers);
    const who = { repo: project, home: homedir(), user: process.env.USERNAME || process.env.USER };
    const base = run("git", ["rev-parse", "HEAD"], { cwd: project }).stdout.trim();
    const events = runClaude(project, configDir, scenario);
    const harnessCommits = variant === "with" ? 2 : 1;
    return {
      scenario: scenario.id,
      variant,
      model: scenario.model,
      cli: claudeVersion(configDir),
      recordedAt: new Date().toISOString().slice(0, 10),
      exercised: await exercisedFor(REPO, scenario, variant, answers),
      outcome: {
        ...outcomeFrom(eventsOf(events, "result")),
        ...outcomeOf(project, base, harnessCommits, who),
      },
      turns: replayFrom(events, who),
    };
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

function writeRecording(record) {
  const folder = join(RECORDINGS, record.scenario);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${record.variant}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote recordings/${record.scenario}/${record.variant}.json`);
}

function variantsFrom(arg) {
  if (arg === "both") return VARIANTS;
  if (VARIANTS.includes(arg)) return [arg];
  throw new Error(`variant must be with, without or both, not "${arg}"`);
}

async function main([which = "all", variantArg = "both"]) {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error("Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY.");
    process.exitCode = 1;
    return;
  }
  const data = JSON.parse(readFileSync(join(RECORDINGS, "scenarios.json"), "utf8"));
  const scenarios = data.scenarios.filter((s) => which === "all" || s.id === which);
  if (scenarios.length === 0) throw new Error(`no scenario named "${which}"`);
  for (const scenario of scenarios) {
    for (const variant of variantsFrom(variantArg)) {
      writeRecording(await recordOne(scenario, variant, data.answers));
    }
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

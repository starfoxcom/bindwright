// Bindwright's opt-in review counts. `send <repo root>` runs at session start:
// at most once a day per repo it counts the user's merged pull requests since
// the last send and posts the four counts to the counter. The other commands
// (`share on|off`, `project <root> <kind>`, `status`) keep the answer in
// <config>/bindwright/counts.json. Node 18+, no dependencies; failures change nothing.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/** The project kinds a repo can be filed under. Mirrors the counter's list. */
export const KINDS = Object.freeze([
  "game",
  "business-app",
  "developer-tool",
  "mobile-app",
  "website",
  "other",
]);

const DEFAULT_COUNTER_URL = "https://bindwright-counter.starfoxcom.workers.dev";
const MAX_PER_COUNT = 1000;
const RETRY_GAP_IN_MILLISECONDS = 60 * 1000;
const GH_TIMEOUT_IN_MILLISECONDS = 20 * 1000;
const POST_TIMEOUT_IN_MILLISECONDS = 2000;
const DEEP_LABEL = "needs-deep-review";
const BOT_LOGINS = new Set(["claude", "claude[bot]"]);
const ESCALATION_REQUEST = /@claude review/i;
const LIST_ITEM = /^\s*([-+]|\*\s|\d+[.)])/;
const VERDICT_LINE = /^[\s*_#>]*(🟢|🔴)[\s*_]*(LGTM|Blocking)/i;
const ALREADY_SENT = /already sent/;
const PROJECT_ID = /^[0-9a-f]{32}$/;

const execFileAsync = promisify(execFile);

/** The repo root as the state file keys it: absolute, with links resolved. */
export function repoKey(root) {
  const absolute = resolve(root);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** The local calendar day of a date, as `YYYY-MM-DD`. */
export function localDay(date) {
  return date.toLocaleDateString("en-CA");
}

/** The send URL: BINDWRIGHT_COUNTER_URL names another base, for local runs. */
export function counterUrl(env) {
  const base = (env.BINDWRIGHT_COUNTER_URL || DEFAULT_COUNTER_URL).replace(/\/+$/, "");
  return `${base}/increment`;
}

/** The state file under the Claude config folder. */
export function stateFileIn(configDir) {
  return join(configDir, "bindwright", "counts.json");
}

// The verdict a comment gives: the last verdict line decides, list items never count.
function verdictOf(text) {
  let verdict = null;
  for (const line of text.split(/\r?\n/)) {
    if (LIST_ITEM.test(line)) continue;
    const match = VERDICT_LINE.exec(line);
    if (match) verdict = match[1] === "🟢" ? "green" : "red";
  }
  return verdict;
}

function verdictsOf(pr) {
  return (pr.comments ?? [])
    .filter((comment) => BOT_LOGINS.has(comment.author?.login) && !ESCALATION_REQUEST.test(comment.body ?? ""))
    .map((comment) => verdictOf(comment.body ?? ""))
    .filter((verdict) => verdict !== null);
}

function hasDeepLabel(pr) {
  return (pr.labels ?? []).some((label) => label.name === DEEP_LABEL);
}

/**
 * Counts the four review numbers of merged PRs, as `gh pr list --json
 * number,labels,comments` returns them. Each count is capped at MAX_PER_COUNT.
 *
 * ```js
 * countPrs([{ labels: [], comments: [{ author: { login: "claude" }, body: "🟢 LGTM" }] }]);
 * // { checked: 1, caught: 0, deep: 0, merged: 1 }
 * ```
 */
export function countPrs(prs) {
  const counts = { checked: 0, caught: 0, deep: 0, merged: prs.length };
  for (const pr of prs) {
    const verdicts = verdictsOf(pr);
    if (verdicts.length === 0) continue;
    counts.checked += 1;
    if (verdicts.includes("red")) counts.caught += 1;
    if (hasDeepLabel(pr)) counts.deep += 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, Math.min(count, MAX_PER_COUNT)]));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isProject(entry) {
  return PROJECT_ID.test(entry?.id) && typeof entry.since === "string";
}

/** The state, or sharing off and no projects when the file is missing or damaged. */
export function readState(file) {
  const parsed = readJson(file);
  const projects = Object.fromEntries(
    Object.entries(parsed?.projects ?? {}).filter(([, entry]) => isProject(entry)),
  );
  return { share: parsed?.share === true, projects };
}

// Written through a temporary file, so no reader sees it half written.
function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

// Applies `change` to one repo's entry in a fresh read of the file, so a
// `project` or `share` write from another process is kept.
function changeProject(file, key, change) {
  const state = readState(file);
  const entry = state.projects[key];
  if (!entry) return;
  Object.assign(entry, change);
  writeState(file, state);
}

const fail = (error) => ({ error });

/** Turns the share switch on or off. */
export function setShare(file, value) {
  if (value !== "on" && value !== "off") return fail("share takes on or off");
  const state = readState(file);
  state.share = value === "on";
  writeState(file, state);
  return { share: state.share };
}

/** Adds a repo with a new random id, or sets the kind of a repo already added. */
export function setProject(file, root, kind, now = () => new Date()) {
  if (!root) return fail("project takes a repo root and a kind");
  if (!KINDS.includes(kind)) return fail(`kind must be one of: ${KINDS.join(", ")}`);
  const state = readState(file);
  const key = repoKey(root);
  const entry = state.projects[key] ?? {
    id: randomBytes(16).toString("hex"),
    since: now().toISOString(),
    lastSendDay: null,
    failedAt: null,
  };
  entry.kind = kind;
  state.projects[key] = entry;
  writeState(file, state);
  return { project: key, kind };
}

/** Whether the question was answered, the share switch, and each repo's kind and last send day. Never ids. */
export function statusOf(file) {
  const parsed = readJson(file);
  const state = readState(file);
  return {
    asked: typeof parsed?.share === "boolean",
    share: state.share,
    projects: Object.entries(state.projects).map(([root, entry]) => ({
      root,
      kind: entry.kind,
      lastSendDay: entry.lastSendDay,
    })),
  };
}

function prListArgs(since) {
  return [
    "pr", "list", "--state", "merged", "--author", "@me",
    "--search", `merged:>=${since}`, "--json", "number,labels,comments", "--limit", "1000",
  ];
}

async function runGhJson(args, cwd) {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    timeout: GH_TIMEOUT_IN_MILLISECONDS,
    windowsHide: true,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_IN_MILLISECONDS),
  });
  const reply = await res.json().catch(() => null);
  return { status: res.status, error: reply?.error ?? "" };
}

function isDue(entry, current) {
  if (entry.lastSendDay === localDay(current)) return false;
  if (typeof entry.failedAt !== "number") return true;
  return current.getTime() - entry.failedAt >= RETRY_GAP_IN_MILLISECONDS;
}

// What the counter's answer changes in the repo's entry. A 429 saying the
// project already sent today keeps `since`, so those PRs go in the next send.
function outcomeChange(outcome, { queryTime, today, failedAt }) {
  if (outcome?.status === 200) return { since: queryTime, lastSendDay: today, failedAt: null };
  if (outcome?.status === 429 && ALREADY_SENT.test(outcome.error)) return { lastSendDay: today };
  return { failedAt };
}

/**
 * The daily send for one repo. It changes the state only through `changeProject`,
 * after each outcome. `ghJson(args, cwd)`, `post(url, body)` and `now()` are
 * injectable so tests run without gh or the network.
 */
export async function send({
  root,
  stateFile,
  url,
  now = () => new Date(),
  ghJson = runGhJson,
  post = postJson,
}) {
  const key = repoKey(root);
  const state = readState(stateFile);
  const entry = state.share ? state.projects[key] : undefined;
  const current = now();
  if (!entry || !isDue(entry, current)) return;
  const today = localDay(current);
  const queryTime = current.toISOString();
  const prs = await ghJson(prListArgs(entry.since), key).catch(() => null);
  if (!Array.isArray(prs)) return;
  const counts = countPrs(prs);
  if (Object.values(counts).every((count) => count === 0)) {
    return changeProject(stateFile, key, { since: queryTime });
  }
  const outcome = await post(url, { project: entry.id, kind: entry.kind, ...counts }).catch(() => null);
  return changeProject(stateFile, key, outcomeChange(outcome, { queryTime, today, failedAt: current.getTime() }));
}

function command([name, ...args], file) {
  if (name === "share") return setShare(file, args[0]);
  if (name === "project") return setProject(file, args[0], args[1]);
  if (name === "status") return statusOf(file);
  return fail("usage: share on|off | project <root> <kind> | status | send <root>");
}

async function main(argv) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const stateFile = stateFileIn(configDir);
  if (argv[0] === "send") {
    await send({ root: argv[1], stateFile, url: counterUrl(process.env) }).catch(() => {});
    return;
  }
  const result = command(argv, stateFile);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = "error" in result ? 1 : 0;
}

// Run as the hook or the CLI, not when a test imports it. The path is compared
// after following links, as notice.mjs does.
function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry()) {
  main(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}

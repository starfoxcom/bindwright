// Bindwright's opt-in review counts. `send <repo root>` counts the user's merged pull
// requests and posts the review counts to the counter, at most once every 24 hours per
// repo. A repo's count covers its whole history, from GitHub's first day. A history past
// one send's cap goes out one batch per cooldown: oldest first when backfill is on,
// otherwise only the newest batch is sent. The other commands
// (`share on|off`, `project <root> <kind>`, `backfill <root> on|off`, `history <root>`,
// `status`) keep the answer in <config>/bindwright/counts.json. Node 18+, no
// dependencies; failures change nothing.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { writeFileAtomic } from "./write-file.mjs";
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

/** The kind answer that leaves a repo out of the counts; it is remembered, so nobody asks again. */
export const LEFT_OUT = "none";

/** Where a repo's history starts: no PR on GitHub is older, so it starts before every one. */
export const HISTORY_START = "2008-01-01T00:00:00.000Z";

const DEFAULT_COUNTER_URL = "https://bindwright-counter.starfoxcom.workers.dev";
// The most PRs one send carries. A count past it is capped, and a batch holds at most this many.
const BATCH_CAP = 500;
const MAX_PER_COUNT = BATCH_CAP;
// Room for 500 PRs at a 50-round ceiling each: the most red rounds one send carries.
export const MAX_ROUNDS = BATCH_CAP * 50;
// Red review rounds that stall a PR: the review rules stop to research a simpler way.
export const STALL_ROUNDS = 3;
// GitHub search returns at most this many results for one query. The listings ask for all of
// them, so a history past BATCH_CAP is visible as past it.
const SEARCH_LIMIT = 1000;
// A batch ends at the 450th merge of a full listing, so PRs created later but merged
// inside the batch still fit under the cap.
const PROBE_INDEX = 449;
const SECOND_IN_MILLISECONDS = 1000;
const RETRY_GAP_IN_MILLISECONDS = 60 * 1000;
// Above the counter's minimum gap between two sends (MIN_SEND_GAP_IN_MILLISECONDS, 20 hours).
const SEND_COOLDOWN_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
// A batch's PRs with all their comments can take three minutes on a busy repo; the send
// runs detached at session start, so nobody waits on it.
const GH_TIMEOUT_IN_MILLISECONDS = 10 * 60 * 1000;
// A batch's PRs with every review comment run to several MiB, past Node's 1 MiB default.
const GH_OUTPUT_LIMIT_IN_BYTES = 256 * 1024 * 1024;
const POST_TIMEOUT_IN_MILLISECONDS = 2000;
const DEEP_LABEL = "needs-deep-review";
const BOT_LOGINS = new Set(["claude", "claude[bot]"]);
const ESCALATION_REQUEST = /@claude review/i;
const LIST_ITEM = /^\s*([-+]|\*\s|\d+[.)])/;
// The deep review's comment, as the review gate tells it apart: its job summary or its plain comment.
const DEEP_SUMMARY = /^\s*(\*\*Claude finished|## Deep review)/;
// A verdict line: leading markup, an optional "Verdict" label, then the glyph and its word.
const VERDICT_LINE = /^[\s*_#>]*(?:Verdict[\s*_]*:?[\s*_]*)?(🟢|🔴)[\s*_]*(LGTM|Blocking|Approved)/i;
const ALREADY_SENT = /already sent/;
const PROJECT_ID = /^[0-9a-f]{32}$/;
const USAGE = [
  "usage: share on|off | project <root> <kind> | backfill <root> on|off",
  "| history <root> | status | send <root>",
].join(" ");

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

/** The send URL; `override` (BINDWRIGHT_COUNTER_URL) names another base, for local runs. */
export function counterUrl(override) {
  const base = (override || DEFAULT_COUNTER_URL).replace(/\/+$/, "");
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

function botComments(pr) {
  return (pr.comments ?? [])
    .filter((comment) => BOT_LOGINS.has(comment.author?.login))
    .filter((comment) => !ESCALATION_REQUEST.test(comment.body ?? ""));
}

// The verdicts of each review round, oldest first. A routine comment opens a round; the
// deep summary of the same push joins the open round, or opens one when none is open.
function roundsOf(pr) {
  const rounds = [];
  for (const comment of botComments(pr)) {
    const body = comment.body ?? "";
    const verdict = verdictOf(body);
    if (verdict === null) continue;
    if (rounds.length === 0 || !DEEP_SUMMARY.test(body)) rounds.push([]);
    rounds.at(-1).push(verdict);
  }
  return rounds;
}

// Each count capped at its limit: `rounds` at MAX_ROUNDS, the rest at BATCH_CAP.
function capped(counts) {
  const entries = Object.entries(counts).map(([name, n]) => {
    const limit = name === "rounds" ? MAX_ROUNDS : MAX_PER_COUNT;
    return [name, Math.min(n, limit)];
  });
  return Object.fromEntries(entries);
}

function hasDeepLabel(pr) {
  return (pr.labels ?? []).some((label) => label.name === DEEP_LABEL);
}

/**
 * Counts the review numbers of merged PRs, as `gh pr list --json
 * number,labels,comments` returns them. A PR with a verdict is checked; each of its red
 * review rounds adds to `rounds`, it is caught with one and stalled with STALL_ROUNDS.
 * Each count is capped at MAX_PER_COUNT, and `rounds` at MAX_ROUNDS.
 *
 * ```js
 * countPrs([{ labels: [], comments: [{ author: { login: "claude" }, body: "🟢 LGTM" }] }]);
 * // { checked: 1, caught: 0, deep: 0, merged: 1, stalled: 0, rounds: 0 }
 * ```
 */
export function countPrs(prs) {
  const counts = { checked: 0, caught: 0, deep: 0, merged: prs.length, stalled: 0, rounds: 0 };
  for (const pr of prs) {
    const rounds = roundsOf(pr);
    if (rounds.length === 0) continue;
    const redRounds = rounds.filter((verdicts) => verdicts.includes("red")).length;
    counts.checked += 1;
    if (redRounds > 0) counts.caught += 1;
    if (redRounds >= STALL_ROUNDS) counts.stalled += 1;
    counts.rounds += redRounds;
    if (hasDeepLabel(pr)) counts.deep += 1;
  }
  return capped(counts);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isProject(entry) {
  const hasSince = typeof entry?.since === "string" && !Number.isNaN(Date.parse(entry.since));
  return PROJECT_ID.test(entry?.id) && hasSince;
}

/** The state, or sharing off and no projects when the file is missing or damaged. */
export function readState(file) {
  const parsed = readJson(file);
  const projects = Object.fromEntries(
    Object.entries(parsed?.projects ?? {}).filter(([, entry]) => isProject(entry)),
  );
  return { share: parsed?.share === true, projects };
}

function writeState(file, state) {
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}
`);
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

/**
 * Adds a repo with a new random id that counts its whole history, or sets the kind of
 * one added; `none` leaves it out.
 */
export function setProject(file, root, kind) {
  if (!root) return fail("project takes a repo root and a kind");
  if (kind !== LEFT_OUT && !KINDS.includes(kind)) {
    return fail(`kind must be one of: ${[...KINDS, LEFT_OUT].join(", ")}`);
  }
  const state = readState(file);
  const key = repoKey(root);
  const entry = state.projects[key] ?? {
    id: randomBytes(16).toString("hex"),
    since: HISTORY_START,
    backfill: false,
    nextSendAt: null,
    failedAt: null,
  };
  entry.kind = kind === LEFT_OUT ? null : kind;
  state.projects[key] = entry;
  writeState(file, state);
  return { project: key, kind };
}

/**
 * Turns backfill on or off for a repo added with `project`. On, a history past one
 * send goes out oldest batch first; off, only the newest batch is sent.
 */
export function setBackfill(file, root, value) {
  if (value !== "on" && value !== "off") return fail("backfill takes on or off");
  const key = repoKey(root);
  const state = readState(file);
  const entry = state.projects[key];
  if (!entry) return fail("no project for this repo: add it with project <root> <kind> first");
  entry.backfill = value === "on";
  writeState(file, state);
  return { project: key, backfill: entry.backfill };
}

/** Whether the question was answered, the share switch, and each repo's kind and last send. */
export function statusOf(file) {
  const parsed = readJson(file);
  const state = readState(file);
  return {
    asked: typeof parsed?.share === "boolean",
    share: state.share,
    projects: Object.entries(state.projects).map(([root, entry]) => ({
      root,
      kind: entry.kind,
      nextSendAt: entry.nextSendAt ?? null,
    })),
  };
}

function prListArgs(search, fields) {
  return [
    "pr", "list", "--state", "merged", "--author", "@me",
    "--search", search, "--json", fields, "--limit", String(SEARCH_LIMIT),
  ];
}

async function runGhJson(args, cwd) {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    timeout: GH_TIMEOUT_IN_MILLISECONDS,
    maxBuffer: GH_OUTPUT_LIMIT_IN_BYTES,
    windowsHide: true,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

// The merged PRs a search returns, as the given --json fields. A reply that is not a list throws.
async function listPrs(search, fields, cwd, ghJson) {
  const prs = await ghJson(prListArgs(search, fields), cwd);
  if (!Array.isArray(prs)) throw new Error("gh did not return a list");
  return prs;
}

// Whether a search holds at most BATCH_CAP PRs, so one batch can carry all of them.
async function fitsInBatch(search, cwd, ghJson) {
  const prs = await listPrs(search, "number", cwd, ghJson);
  return prs.length <= BATCH_CAP;
}

// The merge times of a listing, oldest first.
function oldestFirst(prs) {
  return prs.map((pr) => pr.mergedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
}

// The positions to try as a batch end: the probe position, then halved toward the first.
function* probePositions() {
  for (let index = PROBE_INDEX; index >= 0; index = Math.floor((index - 1) / 2)) yield index;
}

// The oldest batch: from the start of the history to a merge time in the listing of the
// oldest-created PRs, which holds the earliest merges.
async function oldestBatch({ since, cwd, ghJson }) {
  const listed = await listPrs(`merged:>=${since} sort:created-asc`, "mergedAt", cwd, ghJson);
  const times = oldestFirst(listed);
  for (const index of probePositions()) {
    const end = times[index];
    const search = `merged:${since}..${end}`;
    if (await fitsInBatch(search, cwd, ghJson)) {
      return {
        from: Date.parse(since),
        to: Date.parse(end),
        search,
        nextSince: new Date(Date.parse(end) + SECOND_IN_MILLISECONDS).toISOString(),
      };
    }
  }
  return null;
}

// The newest batch: from a probe position's merge time up to now. Older merges are skipped.
async function newestBatch({ listed, current, cwd, ghJson }) {
  const newestFirst = oldestFirst(listed).reverse();
  for (const index of probePositions()) {
    const start = newestFirst[index];
    const search = `merged:>=${start}`;
    if (await fitsInBatch(search, cwd, ghJson)) {
      return {
        from: Date.parse(start),
        to: current.getTime(),
        search,
        nextSince: current.toISOString(),
      };
    }
  }
  return null;
}

/**
 * The merged PRs one send covers: `{ from, to, search, nextSince }`, with the times in
 * epoch ms, a gh search that selects exactly those PRs, and the `since` the repo takes
 * once the send is accepted. A history under the cap is one window from `since` to now.
 * Past the cap, `backfill` takes the oldest batch and otherwise the newest. Null when no
 * batch under the cap is found.
 */
export async function planWindow({ since, current, backfill, ghJson = runGhJson, cwd }) {
  const listed = await listPrs(`merged:>=${since}`, "mergedAt", cwd, ghJson);
  if (listed.length <= BATCH_CAP) {
    return {
      from: Date.parse(since),
      to: current.getTime(),
      search: `merged:>=${since}`,
      nextSince: current.toISOString(),
    };
  }
  return backfill
    ? oldestBatch({ since, cwd, ghJson })
    : newestBatch({ listed, current, cwd, ghJson });
}

/**
 * Whether a repo's merged PRs since its start are more than one batch holds, so the
 * question whether to send the history in batches is worth asking.
 */
export async function historyOf({ root, stateFile, ghJson = runGhJson }) {
  const key = repoKey(root);
  const since = readState(stateFile).projects[key]?.since ?? HISTORY_START;
  const prs = await listPrs(`merged:>=${since}`, "number", key, ghJson);
  return { overLimit: prs.length > BATCH_CAP };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_IN_MILLISECONDS),
  });
  const reply = await res.json().catch(() => null);
  return { status: res.status, error: reply?.error ?? "", coveredTo: reply?.coveredTo };
}

// Whether the cooldown has passed. An entry from before the cooldown has only `lastSendDay`,
// and keeps the once-a-local-day rule until its next send writes `nextSendAt`.
function isCooledDown(entry, current) {
  // A saved time that is not a date counts as none, so a damaged entry cannot stop every send.
  const next = Date.parse(entry.nextSendAt ?? "");
  if (!Number.isNaN(next)) return current.getTime() >= next;
  if (entry.lastSendDay) return localDay(current) !== entry.lastSendDay;
  return true;
}

function isDue(entry, current) {
  if (!isCooledDown(entry, current)) return false;
  if (typeof entry.failedAt !== "number") return true;
  return current.getTime() - entry.failedAt >= RETRY_GAP_IN_MILLISECONDS;
}

// What a send that ended well (taken, already counted, or nothing to count) leaves in the
// entry: the next send waits a cooldown, and the old day field and any failure are cleared.
function cooldownFrom(current) {
  const nextSendAt = new Date(current.getTime() + SEND_COOLDOWN_IN_MILLISECONDS).toISOString();
  return { nextSendAt, lastSendDay: null, failedAt: null };
}

// What the counter's answer changes in the repo's entry. A 409 means an earlier
// send of this window was counted though its answer was lost: counting resumes
// one second after the counter's count stops, since a window's end is inclusive.
// A 429 saying the project already sent keeps `since`, so those PRs go in the next send.
function outcomeChange(outcome, { batch, current }) {
  if (outcome?.status === 200) {
    return { since: batch.nextSince, failedAt: null, ...cooldownFrom(current) };
  }
  if (outcome?.status === 409 && Number.isSafeInteger(outcome.coveredTo)) {
    const resume = new Date(outcome.coveredTo + SECOND_IN_MILLISECONDS);
    return { since: resume.toISOString(), failedAt: null };
  }
  if (outcome?.status === 429 && ALREADY_SENT.test(outcome.error)) return cooldownFrom(current);
  return { failedAt: current.getTime() };
}

/**
 * The send for one repo, once its cooldown has passed: the next batch of its merged PRs
 * (see `planWindow`). It changes the state only through `changeProject`, after each
 * outcome. `ghJson(args, cwd)`, `post(url, body)` and `now()` are injectable so tests run
 * without gh or the network.
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
  if (!entry?.kind || !isDue(entry, current)) return;
  // A gh that fails (signed out, missing, offline) is a failed send too, so session start can name it.
  const failed = () => changeProject(stateFile, key, { failedAt: current.getTime() });
  let batch;
  try {
    batch = await planWindow({ since: entry.since, current, backfill: entry.backfill === true, ghJson, cwd: key });
  } catch {
    return failed();
  }
  if (!batch) return;
  const prs = await listPrs(batch.search, "number,labels,comments", key, ghJson).catch(() => null);
  if (!prs) return failed();
  const counts = countPrs(prs);
  if (Object.values(counts).every((count) => count === 0)) {
    return changeProject(stateFile, key, { since: batch.nextSince, ...cooldownFrom(current) });
  }
  const body = { project: entry.id, kind: entry.kind, ...counts, from: batch.from, to: batch.to };
  const outcome = await post(url, body).catch(() => null);
  const change = outcomeChange(outcome, { batch, current });
  return changeProject(stateFile, key, change);
}

function command([name, ...args], file) {
  if (name === "share") return setShare(file, args[0]);
  if (name === "project") return setProject(file, args[0], args[1]);
  if (name === "backfill") return setBackfill(file, args[0], args[1]);
  if (name === "history") {
    return historyOf({ root: args[0], stateFile: file }).catch((error) => fail(error.message));
  }
  if (name === "status") return statusOf(file);
  return fail(USAGE);
}

async function main(argv) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const stateFile = stateFileIn(configDir);
  if (argv[0] === "send") {
    await send({ root: argv[1], stateFile, url: counterUrl(process.env.BINDWRIGHT_COUNTER_URL) }).catch(() => {});
    return;
  }
  const result = await command(argv, stateFile);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = "error" in result ? 1 : 0;
}

// Run as a script (the notice starts it) or the CLI, not when a test imports it. The path is compared
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

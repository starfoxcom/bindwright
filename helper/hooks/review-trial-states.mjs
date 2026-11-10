// Builds the states of a review trial from a repo's merged pull requests. A state is one review
// tier's run on a pull-request commit with its confirmed outcome, the tasks that
// helper/workflows/review-trial.js compares models on. `node review-trial-states.mjs <repo root>
// [--tier routine|deep] [--count N]` prints one line of JSON:
// { "states": [...], "skipped": [...] }, plus "error" when gh cannot list the pull requests or
// the repo has no review comments of the tier. Node 18+, no dependencies. gh and git run from
// the repo root.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/** The truth of a clean state: the review found nothing and nothing later contradicted it. */
export const CLEAN_TRUTH = "Clean: the confirmed outcome is LGTM with no findings.";

const DEFAULT_COUNT = 4;
const PULL_REQUEST_LIMIT = 50;
const TRUTH_LIMIT = 4000;
const BODY_LIMIT = 2000;
const TIERS = ["routine", "deep"];
const FLAGS = new Set(["--tier", "--count"]);
const USAGE = "usage: review-trial-states.mjs <repo root> [--tier routine|deep] [--count N]";
const MARKERS = {
  routine: /<!-- review-run: (\d+)-(\d+) review -->/,
  deep: /<!-- deep-run: (\d+)-(\d+) review -->/,
};
const REQUEST_MARKER = /<!-- review-run: (\d+)-(\d+) request -->/;
const VERDICT_LINE = /🔴|🟢/;
const GATE_BOT = "claude[bot]";
// What the deep workflow starts on: a comment, review comment or review body that begins with
// this phrase, in any letter case, as GitHub Actions' startsWith compares it.
const DEEP_TRIGGER = /^\s*@claude review this PR/i;
// The gate's early block: a line that opens, after list, quote, heading or emphasis markup, with
// a 🔴 or the word Blocking blocks wherever it sits, whatever the last line says.
const RED_OPENER = /^(?:\[[ xX]\]|(?!\[[ xX]\]|[`🔴🟢])\P{L})*🔴/u;
const BLOCKING_OPENER =
  /^(?:\[[ xX]\]|(?!\[[ xX]\]|[`🟢])\P{L})*(?:Blocking|BLOCKING)(?![\p{L}\p{N}])/u;
const MARKER_LINE = /<!--.*-->/;
const GH_TIMEOUT_IN_MILLISECONDS = 120 * 1000;
const COMMAND_BUFFER_IN_BYTES = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

/** The run id and attempt in a review comment's marker for `tier`, or null. */
export function reviewMarkerOf(body, tier) {
  const found = MARKERS[tier].exec(body);
  return found ? { runId: found[1], attempt: found[2] } : null;
}

// The index of the verdict line: the review gate reads the last line holding a glyph, since a
// review lists its findings first and ends on its verdict. -1 when no line holds one.
function verdictIndexOf(lines) {
  for (let i = lines.length - 1; i >= 0; --i) if (VERDICT_LINE.test(lines[i])) return i;
  return -1;
}

/** The verdict on the last line with a glyph: "Blocking" for red, "LGTM" for green, else null. */
export function verdictOf(body) {
  const lines = body.split(/\r?\n/);
  const at = verdictIndexOf(lines);
  if (at === -1) return null;
  if (lines.some((line) => RED_OPENER.test(line) || BLOCKING_OPENER.test(line))) return "Blocking";
  return lines[at].includes("🔴") ? "Blocking" : "LGTM";
}

/** The review's findings: its text without marker lines and the verdict line, trimmed and cut. */
export function truthOf(body) {
  const lines = body.split(/\r?\n/);
  const at = verdictIndexOf(lines);
  return lines
    .filter((text, i) => i !== at && !MARKER_LINE.test(text))
    .join("\n")
    .trim()
    .slice(0, TRUTH_LIMIT);
}

// Only the review gate's own app writes the reviews and requests the gate reads.
function isBot(comment) {
  return comment.user?.login === GATE_BOT;
}

/** The bots' review comments for `tier` that carry a verdict, oldest first. */
export function reviewsOf(comments, tier) {
  const reviews = [];
  for (const comment of comments.filter(isBot)) {
    const body = comment.body ?? "";
    const marker = reviewMarkerOf(body, tier);
    const verdict = verdictOf(body);
    if (marker && verdict) {
      reviews.push({ ...marker, verdict, body, createdAt: comment.created_at ?? "" });
    }
  }
  return reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// The request the deep tier received for `review`: the newest comment before it that starts a
// deep run, from anyone. Only the gate's own marked request names the run on the reviewed head;
// a bare trigger typed by a person names none, so the review then has no known commit.
function requestFor(comments, review) {
  const triggers = comments
    .filter((comment) => DEEP_TRIGGER.test(comment.body ?? ""))
    .filter((comment) => (comment.created_at ?? "") < review.createdAt)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  const last = triggers[triggers.length - 1];
  return last && isBot(last) && REQUEST_MARKER.test(last.body) ? last : null;
}

/** The input a tier received: the deep tier's request comment when present, else the PR text. */
export function promptOf(tier, pr, comments, review) {
  const request = tier === "deep" ? requestFor(comments, review) : null;
  const body = (pr.body ?? "").slice(0, BODY_LIMIT);
  const text = `Pull request #${pr.number}: ${pr.title}\n\n${body}`;
  return request ? request.body.trim() : text;
}

/**
 * The run whose head commit is the one `review` read, or null when none names it. A deep run
 * starts on a comment, so GitHub files it under the default branch's tip; the request that
 * started it carries the routine run, which ran on the pull request's head.
 */
export function readRunIdOf(tier, comments, review) {
  if (tier !== "deep") return review.runId;
  const request = requestFor(comments, review);
  return request ? REQUEST_MARKER.exec(request.body)[1] : null;
}

function candidateOf(pr, comments, tier, kind, review, truth) {
  return {
    kind,
    pr: pr.number,
    runId: readRunIdOf(tier, comments, review),
    mergeOid: pr.mergeCommit?.oid ?? null,
    truth,
    prompt: promptOf(tier, pr, comments, review),
  };
}

/**
 * The states one PR offers for a tier, newest first. Dirty: a Blocking review that a later
 * review of the tier turned LGTM, with the Blocking text as truth. Clean: the PR's only review
 * of the tier, when it is LGTM.
 */
export function candidatesOf(pr, comments, tier) {
  const reviews = reviewsOf(comments, tier);
  const dirty = reviews
    .flatMap((review, i) => {
      const cleared = reviews.slice(i + 1).some((later) => later.verdict === "LGTM");
      if (review.verdict !== "Blocking" || !cleared) return [];
      return [candidateOf(pr, comments, tier, "dirty", review, truthOf(review.body))];
    })
    .reverse();
  const clean = reviews.length === 1 && reviews[0].verdict === "LGTM"
    ? [candidateOf(pr, comments, tier, "clean", reviews[0], CLEAN_TRUTH)]
    : [];
  return [...dirty, ...clean];
}

function addState(context, candidate, commit) {
  const number = (context.perPr.get(candidate.pr) ?? 0) + 1;
  context.perPr.set(candidate.pr, number);
  const id = number === 1 ? `pr-${candidate.pr}` : `pr-${candidate.pr}-${number}`;
  context.states.push({
    id, pr: candidate.pr, kind: candidate.kind, sha: commit.sha, base: commit.base,
    prompt: candidate.prompt, truth: candidate.truth,
  });
}

// Walks `list` in order, resolving each candidate until `enough()` holds. A candidate whose
// commit cannot be used is recorded in `skipped` with its reason.
async function takeUntil(context, list, enough) {
  for (const candidate of list) {
    if (enough()) return;
    const taken = context.perPr.get(candidate.pr) ?? 0;
    if (context.tried.has(candidate) || taken >= context.perPullRequest) continue;
    context.tried.add(candidate);
    const found = await context.resolve(candidate);
    if (found.reason) context.skipped.push({ pr: candidate.pr, reason: found.reason });
    else addState(context, candidate, found);
  }
}

/**
 * Picks up to `count` states from newest-first candidates: up to count - 1 dirty and one clean,
 * then fills from whichever kind has room. `resolve(candidate)` gives { sha, base } or { reason }.
 * Each PR contributes at most `perPullRequest` states.
 */
export async function pickStates(candidates, count, resolve, perPullRequest = 1) {
  const context = {
    states: [], skipped: [], perPr: new Map(), tried: new Set(), resolve, perPullRequest,
  };
  const dirty = candidates.filter((candidate) => candidate.kind === "dirty");
  const clean = candidates.filter((candidate) => candidate.kind === "clean");
  const kindCount = (kind) => context.states.filter((state) => state.kind === kind).length;
  await takeUntil(context, dirty, () => kindCount("dirty") >= count - 1);
  await takeUntil(context, clean, () => kindCount("clean") >= 1);
  await takeUntil(context, [...dirty, ...clean], () => context.states.length >= count);
  return { states: context.states, skipped: context.skipped };
}

async function ghText(root, args) {
  const { stdout } = await execFileAsync("gh", args, {
    cwd: root, timeout: GH_TIMEOUT_IN_MILLISECONDS, windowsHide: true,
    encoding: "utf8", maxBuffer: COMMAND_BUFFER_IN_BYTES,
  });
  return stdout.trim();
}

async function ghJson(root, args) {
  return JSON.parse(await ghText(root, args));
}

// The output of a git command, or null when it fails.
async function gitText(root, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: COMMAND_BUFFER_IN_BYTES,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** A pull request review as a comment: its body, its author and when it was submitted. */
export function reviewAsComment(review) {
  return { body: review.body ?? "", created_at: review.submitted_at ?? "", user: review.user };
}

// The PR's comments; for the deep tier also its review comments and review bodies, since a deep
// run starts on any of the three.
async function commentsOf(root, repo, number, tier) {
  // --slurp gives one array of the pages' arrays, which flat() joins.
  const list = async (path) => (await ghJson(root, [
    "api", `repos/${repo}/${path}`, "--paginate", "--slurp",
  ])).flat();
  const comments = await list(`issues/${number}/comments`);
  if (tier !== "deep") return comments;
  const reviewComments = await list(`pulls/${number}/comments`);
  const reviews = (await list(`pulls/${number}/reviews`)).map(reviewAsComment);
  return [...comments, ...reviewComments, ...reviews];
}

// The gh and git readers resolveCandidate uses; a test passes its own.
const READERS = { gh: ghText, git: gitText };

/** The commit a candidate's run reviewed and its merge base, or the reason neither can be used. */
export async function resolveCandidate(root, repo, candidate, readers = READERS) {
  if (candidate.mergeOid === null) return { reason: `PR #${candidate.pr} has no merge commit` };
  if (candidate.runId === null) {
    return { reason: `no request names the commit the deep review of PR #${candidate.pr} read` };
  }
  const endpoint = `repos/${repo}/actions/runs/${candidate.runId}`;
  let event;
  let sha;
  try {
    [event, sha] = (await readers.gh(root, ["api", endpoint, "--jq", '.event + " " + .head_sha']))
      .split(" ");
  } catch {
    return { reason: `run ${candidate.runId} of PR #${candidate.pr} could not be read` };
  }
  // Only a pull-request run's head is the pull request's commit.
  if (!event.startsWith("pull_request")) {
    return { reason: `run ${candidate.runId} of PR #${candidate.pr} did not run on its head` };
  }
  if ((await readers.git(root, ["cat-file", "-e", `${sha}^{commit}`])) === null) {
    return { reason: `commit ${sha.slice(0, 12)} of PR #${candidate.pr} is not in this clone` };
  }
  const base = await readers.git(root, ["merge-base", sha, `${candidate.mergeOid}^1`]);
  if (base === null || base === "") {
    return { reason: `commit ${sha.slice(0, 12)} of PR #${candidate.pr} has no merge base` };
  }
  return { sha, base };
}

// The candidates of every PR, newest PR first, and how many of the tier's reviews were seen.
async function collect(root, repo, pulls, tier) {
  const out = { candidates: [], skipped: [], reviewCount: 0 };
  for (const pr of pulls) {
    let comments;
    try {
      comments = await commentsOf(root, repo, pr.number, tier);
    } catch {
      out.skipped.push({ pr: pr.number, reason: "its comments could not be listed" });
      continue;
    }
    out.reviewCount += reviewsOf(comments, tier).length;
    out.candidates.push(...candidatesOf(pr, comments, tier));
  }
  return out;
}

/** The trial states of the repo at `root` for `tier`, `count` of them when the repo has enough. */
export async function trialStates(root, { tier, count }) {
  let repo;
  let pulls;
  try {
    repo = await ghText(root, [
      "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner",
    ]);
    pulls = await ghJson(root, [
      "pr", "list", "--state", "merged", "--limit", String(PULL_REQUEST_LIMIT),
      "--json", "number,title,body,mergeCommit",
    ]);
  } catch {
    return {
      states: [], skipped: [],
      error: "gh could not list this repo's merged pull requests; "
        + "check that gh is installed and signed in",
    };
  }
  const { candidates, skipped, reviewCount } = await collect(root, repo, pulls, tier);
  if (reviewCount === 0) {
    const error = `no ${tier} review comments on the merged pull requests`;
    return { states: [], skipped, error };
  }
  const resolve = (candidate) => resolveCandidate(root, repo, candidate);
  const picked = await pickStates(candidates, count, resolve);
  return { states: picked.states, skipped: [...skipped, ...picked.skipped] };
}

/** The CLI arguments as { root, tier, count }, or { error } when they are not usable. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (FLAGS.has(argv[i])) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  const tier = "tier" in flags ? flags.tier : "routine";
  const count = "count" in flags ? Number(flags.count) : DEFAULT_COUNT;
  if (positional.length !== 1 || !TIERS.includes(tier) || !Number.isInteger(count) || count < 1) {
    return { error: USAGE };
  }
  return { root: positional[0], tier, count };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stdout.write(`${JSON.stringify({ error: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await trialStates(resolve(options.root), options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Run as the CLI, not when a test imports it. The path is compared after following links.
function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ states: [], skipped: [], error: error.message })}\n`);
    process.exitCode = 1;
  });
}

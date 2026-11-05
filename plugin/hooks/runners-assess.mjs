// Assesses this computer and a repo for local GitHub Actions runners and recommends how
// many to set up. `node runners-assess.mjs <repo root>` prints one line of JSON: the
// hardware, whether the shared-PC and runners mods are installed, the repo's workflow
// jobs, how long the jobs of recent runs waited for a runner and how many ran at once, and
// the recommended count. Node 18.15+ (for statfsSync), no dependencies. When gh cannot
// list the runs, the job figures are empty and the rest still answers.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/** What one runner needs: cores, RAM in GB and free disk in GB. */
export const PER_RUNNER = Object.freeze({ cores: 2, ramGB: 4, freeDiskGB: 20 });

/** What stays free for the user on a computer that only runs their own work. */
export const KEEP_BACK = Object.freeze({ cores: 2, ramGB: 4 });

/** What stays free when the computer also runs GPU or timing work, which starves under load. */
export const KEEP_BACK_SHARED = Object.freeze({ cores: 4, ramGB: 8 });

/** What a repo with no CI jobs could still run, fewest runners first. `count` is the runners it needs. */
export const NO_CI_OPTIONS = Object.freeze([
  Object.freeze({ count: 1, runs: "the AI review jobs" }),
  Object.freeze({ count: 2, runs: "the AI review and the tests" }),
  Object.freeze({ count: 3, runs: "the AI review, the tests and a build" }),
]);

const NOTHING_OPTION = Object.freeze({ count: 0, runs: "nothing" });
const GIB = 1024 ** 3;
// A run counts as started the moment it is created; the wait for a runner is per job.
const RUN_SAMPLE = 20;
const GH_TIMEOUT_IN_MILLISECONDS = 60 * 1000;
const USAGE = "usage: runners-assess.mjs <repo root>";
const WORKFLOW_FILE = /\.ya?ml$/;
const JOBS_KEY = /^jobs:\s*(#.*)?$/;
const JOB_KEY = /^[^\s#-][^:#]*:\s*(#.*)?$/;
const RUNS_ON_KEY = /^runs-on:/;
const SELF_HOSTED = /self-hosted/;

const execFileAsync = promisify(execFile);

/**
 * How many runners the computer has room for: the smallest of what its cores, RAM and free
 * disk allow after the keep-back. Free disk has no keep-back.
 *
 * ```js
 * hardwareLimit({ cores: 8, ramGB: 16, freeDiskGB: 100, sharedPc: false }); // 3
 * ```
 */
export function hardwareLimit({ cores, ramGB, freeDiskGB, sharedPc }) {
  const keepBack = sharedPc ? KEEP_BACK_SHARED : KEEP_BACK;
  const fits = Math.min(
    (cores - keepBack.cores) / PER_RUNNER.cores,
    (ramGB - keepBack.ramGB) / PER_RUNNER.ramGB,
    freeDiskGB / PER_RUNNER.freeDiskGB,
  );
  return Math.max(0, Math.floor(fits));
}

/**
 * The jobs of a workflow file and how many of them run on a self-hosted runner. It reads
 * only the shapes these files use: the top-level `jobs:` block and each job's `runs-on:`,
 * inline, as a list or as a flow array.
 *
 * ```js
 * countJobs("jobs:\n  build:\n    runs-on: [self-hosted, linux]\n");
 * // { jobs: 1, selfHosted: 1 }
 * ```
 */
export function countJobs(yamlText) {
  const bodies = jobBodiesOf(contentLinesOf(yamlText));
  return { jobs: bodies.length, selfHosted: bodies.filter(runsOnSelfHosted).length };
}

// Blank and comment lines carry no YAML structure, so they are dropped before the walk.
function contentLinesOf(yamlText) {
  return yamlText
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// The lines from `from` on, while `keep` holds.
function takeWhile(lines, from, keep) {
  let end = from;
  while (end < lines.length && keep(lines[end])) end += 1;
  return lines.slice(from, end);
}

// The body lines of each job under the top-level `jobs:` key. A job key is at the first
// indentation level under `jobs:`, whatever that indentation is.
function jobBodiesOf(lines) {
  const start = lines.findIndex((line) => JOBS_KEY.test(line));
  if (start === -1) return [];
  const block = takeWhile(lines, start + 1, (line) => indentOf(line) > 0);
  if (block.length === 0) return [];
  const jobIndent = indentOf(block[0]);
  const bodies = [];
  for (const line of block) {
    if (indentOf(line) === jobIndent && JOB_KEY.test(line.trimStart())) {
      bodies.push([]);
    } else if (bodies.length > 0) {
      bodies.at(-1).push(line);
    }
  }
  return bodies;
}

// Whether a job's own runs-on names a self-hosted runner. Only the job's first level
// counts, so a runs-on nested deeper in the job is ignored.
function runsOnSelfHosted(body) {
  if (body.length === 0) return false;
  const childIndent = indentOf(body[0]);
  const index = body.findIndex(
    (line) => indentOf(line) === childIndent && RUNS_ON_KEY.test(line.trimStart()),
  );
  return index !== -1 && SELF_HOSTED.test(runsOnTextAt(body, index));
}

// The runs-on value as one string: the text after the key, then any list items or
// flow-array lines below it. A list item may sit at the key's own indentation.
function runsOnTextAt(body, index) {
  const keyIndent = indentOf(body[index]);
  const inline = body[index].trim().slice("runs-on:".length).replace(/\s#.*$/, "");
  const below = takeWhile(body, index + 1, (line) => {
    const indent = indentOf(line);
    return indent > keyIndent || (indent === keyIndent && line.trimStart().startsWith("-"));
  });
  return [inline, ...below].join(" ");
}

/**
 * The waits and overlap of recent jobs, each as `{ createdAt, startedAt, updatedAt }`. A job
 * counts only with all three times in order. `medianWaitSeconds` is the median time from
 * creation to start, and `maxParallel` the most jobs busy at one instant.
 *
 * ```js
 * runStats([{ createdAt, startedAt, updatedAt }]); // { sampled: 1, medianWaitSeconds: 30, maxParallel: 1 }
 * ```
 */
export function runStats(runs) {
  const usable = runs.map(timesOf).filter(Boolean);
  const waits = usable.map(({ created, started }) => (started - created) / 1000);
  const busy = usable.map(({ started, ended }) => [started, ended]);
  return {
    sampled: usable.length,
    medianWaitSeconds: waits.length === 0 ? null : Math.round(medianOf(waits)),
    maxParallel: maxParallelOf(busy),
  };
}

// The create, start and end times of a job in epoch ms, or null when it cannot be counted.
function timesOf(run) {
  const created = Date.parse(run.createdAt);
  const started = Date.parse(run.startedAt);
  const ended = Date.parse(run.updatedAt);
  const inOrder = started >= created && ended >= started;
  return [created, started, ended].every(Number.isFinite) && inOrder
    ? { created, started, ended }
    : null;
}

// The mean of the two middle values when the count is even.
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// The most [start, end) intervals open at one instant. Checking each start as the instant
// makes the largest count; an interval that starts and ends at one instant still counts.
function maxParallelOf(intervals) {
  let most = 0;
  for (const [instant] of intervals) {
    const open = intervals.filter(
      ([start, end]) => start <= instant && (instant < end || start === instant),
    );
    most = Math.max(most, open.length);
  }
  return most;
}

/**
 * What to set up. `none` when the hardware has no room for a runner. `options` when the
 * repo has no CI jobs: the NO_CI_OPTIONS that fit, then `nothing`. Otherwise `count`, the
 * jobs that can run at once, capped at the room the hardware has. `limitedBy` names what
 * stops it, and `wanted` is the count before the cap.
 */
export function recommend({ limit, jobs, maxParallel }) {
  if (limit === 0) return { kind: "none", limitedBy: "hardware" };
  if (jobs === 0) {
    const options = NO_CI_OPTIONS.filter((option) => option.count <= limit);
    return { kind: "options", options: [...options, NOTHING_OPTION] };
  }
  const wanted = Math.min(jobs, Math.max(maxParallel, 1));
  return {
    kind: "count",
    count: Math.min(wanted, limit),
    limitedBy: wanted > limit ? "hardware" : "load",
    wanted,
  };
}

// CLAUDE_CONFIG_DIR when set, otherwise the ~/.claude folder.
function configDirOf(env) {
  return env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude");
}

// Cores, RAM and free disk on the repo's drive, in whole GB where a size is given in GB.
function hardwareOf(root) {
  const disk = statfsSync(root);
  return {
    cores: os.availableParallelism?.() ?? os.cpus().length,
    ramGB: Math.floor(os.totalmem() / GIB),
    freeDiskGB: Math.floor((disk.bavail * disk.bsize) / GIB),
  };
}

// The workflow files directly under .github/workflows, with their jobs. No folder means none.
function workflowsOf(root) {
  const folder = join(root, ".github", "workflows");
  if (!existsSync(folder)) return { workflows: 0, jobs: 0, selfHosted: 0 };
  const files = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && WORKFLOW_FILE.test(entry.name));
  const totals = files.reduce((sum, entry) => {
    const counted = countJobs(readFileSync(join(folder, entry.name), "utf8"));
    return { jobs: sum.jobs + counted.jobs, selfHosted: sum.selfHosted + counted.selfHosted };
  }, { jobs: 0, selfHosted: 0 });
  return { workflows: files.length, ...totals };
}

async function ghJson(root, args) {
  const { stdout } = await execFileAsync("gh", args,
    { cwd: root, timeout: GH_TIMEOUT_IN_MILLISECONDS, windowsHide: true, encoding: "utf8" });
  const value = JSON.parse(stdout);
  return Array.isArray(value) ? value : [];
}

// The jobs of the repo's newest runs, skipped ones left out since they never wait for a
// runner. Any failure (no gh, not signed in, not a GitHub repo) gives no jobs.
async function recentJobs(root) {
  try {
    const runs = await ghJson(root, ["run", "list", "--json", "databaseId", "--limit", String(RUN_SAMPLE)]);
    const lists = await Promise.all(runs.map((run) =>
      ghJson(root, ["api", `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`, "--jq", ".jobs"])
        .catch(() => [])));
    return lists.flat()
      .filter((job) => job.conclusion !== "skipped")
      .map((job) => ({ createdAt: job.created_at, startedAt: job.started_at, updatedAt: job.completed_at }));
  } catch {
    return [];
  }
}

// The whole assessment of this computer and the repo at `root`.
async function assess(root, env) {
  const hardware = hardwareOf(root);
  const configDir = configDirOf(env);
  const sharedPc = existsSync(join(configDir, "mods", "shared-pc"));
  const runnersMod = existsSync(join(configDir, "mods", "runners"));
  const { workflows, jobs, selfHosted } = workflowsOf(root);
  const stats = runStats(await recentJobs(root));
  const limit = hardwareLimit({ ...hardware, sharedPc });
  return {
    hardware,
    sharedPc,
    runnersMod,
    ci: { workflows, jobs, selfHosted, ...stats },
    limit,
    recommendation: recommend({ limit, jobs, maxParallel: stats.maxParallel }),
  };
}

async function main(argv) {
  if (!argv[0]) {
    process.stdout.write(`${JSON.stringify({ error: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await assess(resolve(argv[0]), process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Run as the CLI, not when a test imports it. The path is compared after following
// links, as counts.mjs does.
function isEntry() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntry()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}

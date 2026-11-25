// Whether a deep review the review gate waits for can still report. With `needs-deep-review` on, the gate
// stays pending until a deep verdict comes, so a deep run that never started leaves the watch waiting out its
// whole time limit. From `DEEP_START_MS` after the push, with only the review's own checks pending, the watch
// notes when the gate first owes a deep review; `DEEP_GRACE_MS` later it looks for a live deep run on each
// poll until it finds one, and settles when there is none.

import type { EngineInterface } from 'claude-code'

import type { Watch } from '../types'
import { FAILED, PENDING } from './settle'
import { GATE, readGate, REVIEW_JOBS, withVerdict } from './verdict'

/** How long after the push a deep review the gate owes must have started: the routine review asks within minutes. */
export const DEEP_START_MS = 15 * 60_000

/** How long the gate must owe a deep review before a missing run counts as never started. */
export const DEEP_GRACE_MS = 5 * 60_000

// The deep review's workflow, as the review gate's setup names it.
const DEEP_WORKFLOW = 'claude.yml'

const isOwedDeep = (state: string) => /(?:^|;)escalated=yes(?:;|$)/.test(state) && /(?:^|;)deep=none(?:;|$)/.test(state)

// Only the review is left: the gate still pending, every other pending check one of its own jobs, and no
// other check failed, since a failure wakes the session to fix it anyway.
function isWaitingOnReview(watch: Watch): boolean {
  const states = Object.entries(watch.checks)
  const pending = states.filter(([, bucket]) => PENDING.has(bucket)).map(([name]) => name)
  const isOtherFailed = states.some(([name, bucket]) => FAILED.has(bucket) && !REVIEW_JOBS.has(name))
  return !isOtherFailed && pending.includes(GATE) && pending.every(name => REVIEW_JOBS.has(name))
}

// The lines a gh call prints, or `undefined` when it fails.
async function lines($: EngineInterface, argv: string[]): Promise<string[] | undefined> {
  const { stdout, exitCode } = await $.process.run(argv, { timeoutMs: 30_000 })
  return exitCode === 0 ? stdout.split('\n').map(line => line.trim()).filter(Boolean) : undefined
}

// The states of a run that has not finished. A deep run that finished wrote its verdict into the gate, so
// while the gate still owes one, only a run in one of these states can still report.
const ALIVE = ['requested', 'queued', 'pending', 'waiting', 'in_progress']

// How many deep runs for this PR are alive, however early they were created. The deep workflow runs on the
// comment, so its run carries the PR's title as it was then, not its head: a PR renamed since the gate's
// first run (`since`) cannot be told apart, so it reads as `undefined`.
async function deepRunsAlive($: EngineInterface, watch: Watch, since: string): Promise<number | undefined> {
  try {
    const events = `repos/${watch.repo}/issues/${watch.number}/events?per_page=100`
    const renames = '.[] | select(.event == "renamed") | .created_at'
    const renamed = await lines($, ['gh', 'api', '--paginate', events, '--jq', renames])
    if (!renamed || renamed.some(at => Date.parse(at) >= Date.parse(since))) return undefined
    const view = ['gh', 'pr', 'view', String(watch.number), '--repo', watch.repo, '--json', 'title', '--jq', '.title']
    const [title] = (await lines($, view)) ?? []
    if (title === undefined) return undefined
    let count = 0
    for (const status of ALIVE) {
      const path = `repos/${watch.repo}/actions/workflows/${DEEP_WORKFLOW}/runs?per_page=100&status=${status}`
      const titles = await lines($, ['gh', 'api', '--paginate', path, '--jq', '.workflow_runs[] | .display_title'])
      if (titles === undefined) return undefined
      count += titles.filter(name => name === title).length
    }
    return count
  } catch {
    return undefined
  }
}

/**
 * The watch settled as `deepNeverStarted` when the gate has owed a deep review for `DEEP_GRACE_MS` and none
 * started since its first run, or marked `deep.isStarted` once one has, so it is looked up no more. While
 * GitHub reports an Actions incident the incident wake keeps its place. Anything that cannot be read leaves
 * the watch as it is, for the next poll or the time limit.
 */
export async function withDeepStart($: EngineInterface, watch: Watch, now: number): Promise<Watch> {
  const isTooSoon = now - watch.startedAt < DEEP_START_MS
  if (watch.outcome || watch.incident || watch.deep?.isStarted || isTooSoon || !isWaitingOnReview(watch)) {
    return watch
  }
  const gate = await readGate($, watch)
  if (!gate?.startedAt || !isOwedDeep(gate.state)) return watch
  // The request posts before the gate records it, so the deep run gets time to be created.
  if (watch.deep === undefined) return { ...watch, deep: { owedSince: now } }
  if (now - watch.deep.owedSince < DEEP_GRACE_MS) return watch
  const alive = await deepRunsAlive($, watch, gate.startedAt)
  if (alive === undefined) return watch
  if (alive > 0) return { ...watch, deep: { ...watch.deep, isStarted: true } }
  return { ...watch, outcome: 'timeout', settledAt: now, deepNeverStarted: true }
}

/** A polled watch with what the review gate's state adds: a deep review that never started, or no verdict. */
export async function withReview($: EngineInterface, watch: Watch, now: number): Promise<Watch> {
  return withVerdict($, await withDeepStart($, watch, now))
}

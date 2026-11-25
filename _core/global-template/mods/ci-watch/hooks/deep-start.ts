// Whether a deep review the review gate waits for ever started. With `needs-deep-review` on, the gate stays
// pending until a deep verdict comes, so a deep run that never started leaves the watch waiting out its whole
// time limit. Past `DEEP_START_MS` with only the review's own checks pending, the watch looks once for the run
// and settles at once when there is none.

import type { EngineInterface } from 'claude-code'

import type { Watch } from '../types'
import { PENDING } from './settle'
import { GATE, readGate, REVIEW_JOBS, withVerdict } from './verdict'

/** How long after the push a deep review the gate owes must have started: the routine review asks within minutes. */
export const DEEP_START_MS = 15 * 60_000

// The deep review's workflow, as the review gate's setup names it.
const DEEP_WORKFLOW = 'claude.yml'

const isOwedDeep = (state: string) => /(?:^|;)escalated=yes(?:;|$)/.test(state) && /(?:^|;)deep=none(?:;|$)/.test(state)

// Only the review is left: the gate still pending, and every other pending check one of its own jobs.
function isWaitingOnReview(watch: Watch): boolean {
  const pending = Object.entries(watch.checks).filter(([, bucket]) => PENDING.has(bucket)).map(([name]) => name)
  return pending.includes(GATE) && pending.every(name => REVIEW_JOBS.has(name))
}

// How many deep runs for this PR started since `since`; a run for a comment that asked for none is skipped.
// The deep workflow runs on the comment, so its run carries the PR's title, not its head.
async function deepRunsSince($: EngineInterface, watch: Watch, since: string): Promise<number | undefined> {
  try {
    const view = ['gh', 'pr', 'view', String(watch.number), '--repo', watch.repo, '--json', 'title', '--jq', '.title']
    const title = await $.process.run(view, { timeoutMs: 30_000 })
    if (title.exitCode !== 0) return undefined
    const path = `repos/${watch.repo}/actions/workflows/${DEEP_WORKFLOW}/runs?per_page=100&created=%3E%3D${since}`
    const runs = '[.workflow_runs[] | select(.conclusion != "skipped") | .display_title]'
    const listed = await $.process.run(['gh', 'api', path, '--jq', runs], { timeoutMs: 30_000 })
    if (listed.exitCode !== 0) return undefined
    const titles = JSON.parse(listed.stdout) as string[]
    return titles.filter(name => name === title.stdout.trim()).length
  } catch {
    return undefined
  }
}

/**
 * The watch settled as `deepNeverStarted` when the gate owes a deep review and none started since its first
 * run, or marked `deepStarted` once one has, so it is looked up no more. Anything that cannot be read leaves the
 * watch as it is, for the next poll or the time limit.
 */
export async function withDeepStart($: EngineInterface, watch: Watch, now: number): Promise<Watch> {
  if (watch.outcome || watch.deepStarted || now - watch.startedAt < DEEP_START_MS || !isWaitingOnReview(watch)) {
    return watch
  }
  const gate = await readGate($, watch)
  if (!gate?.startedAt || !isOwedDeep(gate.state)) return watch
  const started = await deepRunsSince($, watch, gate.startedAt)
  if (started === undefined) return watch
  if (started > 0) return { ...watch, deepStarted: true }
  return { ...watch, outcome: 'timeout', settledAt: now, deepNeverStarted: true }
}

/** A polled watch with what the review gate's state adds: a deep review that never started, or no verdict. */
export async function withReview($: EngineInterface, watch: Watch, now: number): Promise<Watch> {
  return withVerdict($, await withDeepStart($, watch, now))
}

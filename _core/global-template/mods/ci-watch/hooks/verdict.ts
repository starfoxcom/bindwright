// Whether a red round is a reviewer's verdict. A review that never reached one (no account with room, a
// refused token or post, a cancelled run) fails the review gate too, but says nothing about the code, so it
// is no fix round.

import type { EngineInterface } from 'claude-code'

import type { Watch } from '../types'
import { FAILED } from './settle'

/** The check both review tiers report into. */
export const GATE = 'Review gate'
// The review workflows' own jobs, which fail beside the gate when a review cannot run.
const REVIEW_JOBS = new Set([
  GATE, 'Init review gate', 'Auto review', 'Post review', 'Evaluate review outcome', 'Claude On-Demand',
  'Check who asked for the deep review', 'On-demand deep review (@claude)',
])
// Each tier's result in the gate's state, as the gate script writes it: `routine=block;deep=error;…`.
const TIER = /(?:^|;)(routine|deep)=(\w+)/g

const failedChecks = (watch: Watch) =>
  Object.entries(watch.checks)
    .filter(([, bucket]) => FAILED.has(bucket))
    .map(([name]) => name)

/** The gate failed, and nothing failed but the review workflows' own jobs. */
export function isReviewOnly(watch: Watch): boolean {
  const failed = failedChecks(watch)
  return failed.includes(GATE) && failed.every(name => REVIEW_JOBS.has(name))
}

/**
 * The state of the newest gate run on the watch's head, picked as the gate script picks it; `undefined` when
 * it cannot be read.
 */
async function gateState($: EngineInterface, watch: Watch): Promise<string | undefined> {
  try {
    const query = `check_name=${encodeURIComponent(GATE)}&per_page=100`
    const path = `repos/${watch.repo}/commits/${watch.headSha}/check-runs?${query}`
    const newest = `[.check_runs[] | select(.name == "${GATE}")] | max_by(.id) | .external_id // ""`
    const { stdout, exitCode } = await $.process.run(['gh', 'api', path, '--jq', newest], { timeoutMs: 30_000 })
    return exitCode === 0 ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

// The job that posts the routine review. The gate holds `error` whenever it fails, also after its 🔴 went
// out, so a run can have given no verdict only when that job was reported and did not fail. The deep tier
// records `error` only when its run posted nothing, and reads any posted review as the gate does.
const POST_JOB = 'Post review'

const isPostClean = (watch: Watch) => POST_JOB in watch.checks && !FAILED.has(watch.checks[POST_JOB] ?? '')

/**
 * The settled watch with `noVerdict` set (`routine error, deep none`) when only the review failed, neither
 * tier blocked, and the routine review's post job did not fail. Anything that cannot be read counts the
 * round, as a real failure would.
 */
export async function withVerdict($: EngineInterface, watch: Watch): Promise<Watch> {
  if (watch.outcome !== 'failed' || watch.isSilent || !isReviewOnly(watch) || !isPostClean(watch)) return watch
  const state = (await gateState($, watch)) ?? ''
  const tiers = new Map([...state.matchAll(TIER)].map(([, tier, result]) => [tier, result]))
  if (!tiers.has('routine') || [...tiers.values()].includes('block')) return watch
  return { ...watch, noVerdict: `routine ${tiers.get('routine')}, deep ${tiers.get('deep') ?? 'none'}` }
}

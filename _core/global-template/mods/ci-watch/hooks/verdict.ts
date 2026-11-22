// Whether a red round is a reviewer's verdict. A review that never reached one (no account with room, a
// refused token or post, a cancelled run) fails the review gate too, but says nothing about the code, so it
// is no fix round.

import type { EngineInterface } from 'claude-code'

import type { Watch } from '../types'
import { FAILED } from './settle'

/** The check both review tiers report into. */
export const GATE = 'Review gate'
// The review workflows' own jobs, which fail beside the gate when a review cannot run.
const REVIEW_JOBS = new Set([GATE, 'Claude On-Demand', 'Auto review', 'Post review', 'Evaluate review outcome'])
// The gate's title when a tier posted a 🔴; its other failure titles name a review that gave no verdict.
const BLOCKED = /^Blocked by the /

const failedChecks = (watch: Watch) =>
  Object.entries(watch.checks)
    .filter(([, bucket]) => FAILED.has(bucket))
    .map(([name]) => name)

/** The gate failed, and nothing failed but the review workflows' own jobs. */
export function isReviewOnly(watch: Watch): boolean {
  const failed = failedChecks(watch)
  return failed.includes(GATE) && failed.every(name => REVIEW_JOBS.has(name))
}

/** The gate's title on the watch's head, `''` when it has none, `undefined` when it cannot be read. */
async function gateTitle($: EngineInterface, watch: Watch): Promise<string | undefined> {
  try {
    const path = `repos/${watch.repo}/commits/${watch.headSha}/check-runs?check_name=${encodeURIComponent(GATE)}`
    const argv = ['gh', 'api', path, '--jq', '.check_runs[0].output.title // ""']
    const { stdout, exitCode } = await $.process.run(argv, { timeoutMs: 30_000 })
    return exitCode === 0 ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * The settled watch with `noVerdict` set to the gate's title when only the review failed and no tier posted
 * a 🔴. A title that cannot be read counts the round, as a real failure would.
 */
export async function withVerdict($: EngineInterface, watch: Watch): Promise<Watch> {
  if (watch.outcome !== 'failed' || watch.isSilent || !isReviewOnly(watch)) return watch
  const title = await gateTitle($, watch)
  if (title === undefined || BLOCKED.test(title)) return watch
  return { ...watch, noVerdict: title || 'no result' }
}

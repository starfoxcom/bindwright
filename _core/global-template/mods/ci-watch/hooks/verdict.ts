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

// A deep-review request or the review action's tracking comment, which quote the verdict rules, not a verdict.
const NOT_VERDICT = /^(?:@claude review this PR|\*\*Claude |Claude Code is working)/i
// A verdict line that blocks: a 🔴 after list, quote, heading or emphasis markup, as the gate reads one.
const RED_VERDICT = /^(?:\[[ xX]\]|[^\p{L}`🔴🟢])*🔴/u

/** Whether a comment body is a review whose verdict line, its last non-empty line, opens with 🔴. */
function isBlockVerdict(body: string): boolean {
  if (NOT_VERDICT.test(body.trimStart())) return false
  const lines = body.split('\n').filter(line => line.trim())
  return RED_VERDICT.test(lines.at(-1)?.trim() ?? '')
}

/**
 * Whether a bot posted a 🔴 verdict on the PR since the watch's push; `undefined` when the comments cannot be
 * read. A review job can fail after its verdict went out, and the gate then holds `error`.
 */
async function hasPostedBlock($: EngineInterface, watch: Watch): Promise<boolean | undefined> {
  try {
    const since = Date.parse(new Date(watch.pushedAt ?? watch.startedAt).toISOString())
    // One JSON line per comment: [author type, created_at, body].
    const rows = '.[] | [.user.type, .created_at, .body] | @json'
    const path = `repos/${watch.repo}/issues/${watch.number}/comments?per_page=100`
    const { stdout, exitCode } = await $.process.run(['gh', 'api', '--paginate', path, '--jq', rows], {
      timeoutMs: 30_000,
    })
    if (exitCode !== 0) return undefined
    return stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as [string, string, string])
      .some(([type, at, body]) => type === 'Bot' && Date.parse(at) >= since && isBlockVerdict(body))
  } catch {
    return undefined
  }
}

/**
 * The settled watch with `noVerdict` set (`routine error, deep none`) when only the review failed, neither
 * tier blocked, and no review posted a 🔴 verdict since the push. Anything that cannot be read counts the round, as
 * a real failure would.
 */
export async function withVerdict($: EngineInterface, watch: Watch): Promise<Watch> {
  if (watch.outcome !== 'failed' || watch.isSilent || !isReviewOnly(watch)) return watch
  const state = (await gateState($, watch)) ?? ''
  const tiers = new Map([...state.matchAll(TIER)].map(([, tier, result]) => [tier, result]))
  if (!tiers.has('routine') || [...tiers.values()].includes('block')) return watch
  if ((await hasPostedBlock($, watch)) !== false) return watch
  return { ...watch, noVerdict: `routine ${tiers.get('routine')}, deep ${tiers.get('deep') ?? 'none'}` }
}

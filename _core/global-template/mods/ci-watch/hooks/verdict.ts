// Whether a red round is a reviewer's verdict. A review run that never got to post its review (no account
// with room, a refused token or post, a cancelled run) fails the review gate too, but says nothing about the
// code, so it is no fix round. Whatever this cannot tell for sure counts the round. The case table in
// tests/rounds.test.ts (`VERDICT_ROWS`) pins which settles count.

import type { EngineInterface } from 'claude-code'

import type { Watch } from '../types'
import { FAILED } from './settle'

/** The check both review tiers report into. */
export const GATE = 'Review gate'
// The review workflows' own jobs, which fail beside the gate when a review cannot run.
export const REVIEW_JOBS = new Set([
  GATE, 'Init review gate', 'Diff triage', 'Project triggers', 'Project pre-screen', 'Auto review', 'Post review',
  'Evaluate review outcome', 'Claude On-Demand',
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

// Tier results the gate can write whether or not a review went out, so the reviews' marks decide.
const UNSURE = new Set(['error', 'pending', 'missing'])
// The marker each tier writes into every review it posts; its deep-review request and tracking comments
// carry other markers.
const REVIEW_MARK = /<!-- (review|deep)-run: \d+-\d+ review -->/g
const MARK_TIER: Record<string, string> = { review: 'routine', deep: 'deep' }

function run($: EngineInterface, args: string[]) {
  return $.process.run(['gh', 'api', ...args], { timeoutMs: 30_000 })
}

/**
 * The newest gate run's state on the watch's head, picked as the gate script picks it, and when the first
 * gate run on that head started, by GitHub's clock; `undefined` when they cannot be read.
 */
export async function readGate($: EngineInterface, watch: Watch) {
  try {
    const query = `check_name=${encodeURIComponent(GATE)}&per_page=100`
    const path = `repos/${watch.repo}/commits/${watch.headSha}/check-runs?${query}`
    const runs = `[.check_runs[] | select(.name == "${GATE}")]`
    const fields = `${runs} | [(max_by(.id) | .external_id) // "", (map(.started_at) | min) // ""] | @tsv`
    const { stdout, exitCode } = await run($, [path, '--jq', fields])
    if (exitCode !== 0) return undefined
    const [state = '', startedAt = ''] = stdout.replace(/\r?\n$/, '').split('\t')
    return { state, startedAt }
  } catch {
    return undefined
  }
}

/** The tiers whose marked reviews a bot posted on the PR since `since`; `undefined` when they cannot be read. */
async function postedTiers($: EngineInterface, watch: Watch, since: string) {
  try {
    const path = `repos/${watch.repo}/issues/${watch.number}/comments?per_page=100`
    // One JSON line per comment: [author type, created_at, body].
    const rows = '.[] | [.user.type, .created_at, .body] | @json'
    const { stdout, exitCode } = await run($, ['--paginate', path, '--jq', rows])
    if (exitCode !== 0) return undefined
    const posted = new Set<string>()
    for (const line of stdout.split('\n').filter(text => text.trim())) {
      const [type, at, body] = JSON.parse(line) as [string, string, string]
      if (type !== 'Bot' || Date.parse(at) < Date.parse(since)) continue
      for (const [, mark] of body.matchAll(REVIEW_MARK)) posted.add(MARK_TIER[mark ?? ''] ?? '')
    }
    return posted
  } catch {
    return undefined
  }
}

/** Whether the repo's deep workflow marks the reviews it posts, which workflows older than the mark do not. */
async function marksDeepReviews($: EngineInterface, watch: Watch): Promise<boolean> {
  try {
    const path = `repos/${watch.repo}/contents/.github/workflows/claude.yml`
    const { stdout, exitCode } = await run($, ['-H', 'Accept: application/vnd.github.raw', path])
    return exitCode === 0 && stdout.includes('<!-- deep-run: ')
  } catch {
    return false
  }
}

/** Whether none of `tiers` posted a review on the head since its first gate run, as their marks show. */
async function isUnposted($: EngineInterface, watch: Watch, since: string, tiers: string[]): Promise<boolean> {
  if (tiers.includes('deep') && !(await marksDeepReviews($, watch))) return false
  const posted = await postedTiers($, watch, since)
  return posted !== undefined && tiers.every(tier => !posted.has(tier))
}

/**
 * The settled watch with `noVerdict` set (`routine error, deep none`) when only the review failed, neither
 * tier blocked, and no tier whose result leaves it open posted a review on the head. Anything that cannot be
 * read counts the round, as a real failure would.
 */
export async function withVerdict($: EngineInterface, watch: Watch): Promise<Watch> {
  if (watch.outcome !== 'failed' || watch.isSilent || !isReviewOnly(watch)) return watch
  const gate = await readGate($, watch)
  const since = gate?.startedAt
  const found = [...(gate?.state ?? '').matchAll(TIER)]
  const tiers = new Map(found.map(([, tier = '', result = '']) => [tier, result]))
  if (!since || !tiers.has('routine') || [...tiers.values()].includes('block')) return watch
  const unsure = [...tiers].filter(([, result]) => UNSURE.has(result)).map(([tier]) => tier)
  // A failed gate whose tiers all read settled is unexplained, so it counts like a failure.
  if (unsure.length === 0 || !(await isUnposted($, watch, since, unsure))) return watch
  return { ...watch, noVerdict: `routine ${tiers.get('routine')}, deep ${tiers.get('deep') ?? 'none'}` }
}

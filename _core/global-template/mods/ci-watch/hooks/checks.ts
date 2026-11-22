import type { EngineInterface } from 'claude-code'

import type { Watch } from '../types'

/**
 * How long a PR may show no check before a repo without workflows counts as having nothing to watch.
 * Checks from outside Actions (commit statuses from Jenkins and the like, other apps' check runs) show up
 * well within it.
 */
export const NO_CHECKS_MS = 10 * 60_000

/**
 * The PR's checks by name, with each one's bucket, and `{}` when GitHub says the PR has none.
 * `undefined` when the read fails (network, auth, a timeout): that is not a quiet poll, so the count
 * stands and the next poll tries again.
 */
export async function readChecks($: EngineInterface, watch: Watch): Promise<Record<string, string> | undefined> {
  try {
    const args = ['gh', 'pr', 'checks', String(watch.number), '--repo', watch.repo, '--json', 'name,bucket']
    // `gh pr checks` exits non-zero while checks are pending; its JSON is still on stdout.
    const { stdout, stderr } = await $.process.run(args, { timeoutMs: 30_000 })
    if (!stdout.trim() && /no checks reported/i.test(stderr)) return {}
    const rows = JSON.parse(stdout.trim()) as { name: string; bucket: string }[]
    return Object.fromEntries(rows.map(row => [row.name, row.bucket]))
  } catch {
    return undefined
  }
}

/** GitHub answers `mergeable` within seconds of being asked; past this the answer counts as mergeable. */
export const MERGEABLE_WAIT_MS = 5 * 60_000

/**
 * A watch that settled with no failure, marked `isConflicting` when GitHub reports its PR conflicting with
 * its base. While GitHub still computes the answer (`UNKNOWN`) the watch stays unsettled for another poll,
 * for up to `MERGEABLE_WAIT_MS` after its checks went quiet. Any failed read leaves the watch as it is.
 */
export async function withMergeable($: EngineInterface, watch: Watch, now: number): Promise<Watch> {
  if (watch.outcome !== 'passed') return watch
  try {
    const args = ['gh', 'pr', 'view', String(watch.number), '--repo', watch.repo, '--json', 'mergeable']
    const { stdout, exitCode } = await $.process.run(args, { timeoutMs: 30_000 })
    const view = exitCode === 0 ? (JSON.parse(stdout) as { mergeable?: string }) : {}
    const isWaiting = view.mergeable === 'UNKNOWN' && now - (watch.quietSince ?? now) < MERGEABLE_WAIT_MS
    if (isWaiting) return { ...watch, outcome: undefined, settledAt: undefined }
    return view.mergeable === 'CONFLICTING' ? { ...watch, isConflicting: true } : watch
  } catch {
    return watch
  }
}

/** A watch whose checks passed on a PR that can merge: a round that judged the code. */
export const isJudgedPass = (watch: Watch) => watch.outcome === 'passed' && !watch.isConflicting

// GitHub answered that the PR has no check, none was ever seen on this head, and the grace time is up.
const isChecklessSince = (watch: Watch, checks: Record<string, string> | undefined, now: number) =>
  checks !== undefined &&
  Object.keys(checks).length === 0 &&
  Object.keys(watch.checks).length === 0 &&
  now - watch.startedAt >= NO_CHECKS_MS

/**
 * The watch with `hasWorkflows` filled in, asked once its PR has shown no check for `NO_CHECKS_MS`. Any
 * answer but a count of zero (an error, a refused call) counts as having workflows, so the watch goes on.
 */
export async function withWorkflows(
  $: EngineInterface,
  watch: Watch,
  checks: Record<string, string> | undefined,
  now: number,
): Promise<Watch> {
  if (watch.hasWorkflows !== undefined || !isChecklessSince(watch, checks, now)) return watch
  try {
    const argv = ['gh', 'api', `repos/${watch.repo}/actions/workflows`, '--jq', '.total_count']
    const { stdout, exitCode } = await $.process.run(argv, { timeoutMs: 30_000 })
    return { ...watch, hasWorkflows: exitCode !== 0 || stdout.trim() !== '0' }
  } catch {
    return { ...watch, hasWorkflows: true }
  }
}

/** A repo without workflows whose PR still shows no check: nothing will come, so the watch ends unwoken. */
export const isNothingToWatch = (watch: Watch, checks: Record<string, string> | undefined, now: number) =>
  watch.hasWorkflows === false && isChecklessSince(watch, checks, now)

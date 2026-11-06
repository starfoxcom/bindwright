import type { EngineInterface } from 'claude-code'

import type { Watch } from '../types'

/**
 * How long a PR may show no check before a repo without workflows counts as having nothing to watch.
 * Checks from outside Actions (commit statuses from Jenkins and the like, other apps' check runs) show up
 * well within it.
 */
export const NO_CHECKS_MS = 10 * 60_000

async function gh($: EngineInterface, args: readonly string[]): Promise<string> {
  // `gh pr checks` exits non-zero while checks are pending; its JSON is still on stdout.
  const { stdout } = await $.process.run(['gh', ...args], { timeoutMs: 30_000 })
  return stdout.trim()
}

/**
 * The PR's checks by name, with each one's bucket. `undefined` when the read fails (network, auth, no
 * checks yet): that is not a quiet poll, so the count stands and the next poll tries again.
 */
export async function readChecks($: EngineInterface, watch: Watch): Promise<Record<string, string> | undefined> {
  try {
    const args = ['pr', 'checks', String(watch.number), '--repo', watch.repo, '--json', 'name,bucket']
    const rows = JSON.parse(await gh($, args)) as { name: string; bucket: string }[]
    return Object.fromEntries(rows.map(row => [row.name, row.bucket]))
  } catch {
    return undefined
  }
}

const isChecklessSince = (watch: Watch, checks: Record<string, string> | undefined, now: number) =>
  Object.keys(checks ?? {}).length === 0 && now - watch.startedAt >= NO_CHECKS_MS

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
    const count = await gh($, ['api', `repos/${watch.repo}/actions/workflows`, '--jq', '.total_count'])
    return { ...watch, hasWorkflows: count !== '0' }
  } catch {
    return { ...watch, hasWorkflows: true }
  }
}

/** A repo without workflows whose PR still shows no check: nothing will come, so the watch ends unwoken. */
export const isNothingToWatch = (watch: Watch, checks: Record<string, string> | undefined, now: number) =>
  watch.hasWorkflows === false && isChecklessSince(watch, checks, now)

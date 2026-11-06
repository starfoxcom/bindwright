import type { EngineInterface } from 'claude-code'

/**
 * Whether GitHub lists any workflow for `repo` (`owner/name`). A repo without workflows reports no
 * checks, so a watch there could only time out. An answer other than a count of zero (an error, a
 * refused call) counts as yes, so the watch goes ahead as it would without this check.
 */
export async function hasWorkflows($: EngineInterface, repo: string): Promise<boolean> {
  try {
    const argv = ['gh', 'api', `repos/${repo}/actions/workflows`, '--jq', '.total_count']
    const { stdout } = await $.process.run(argv, { timeoutMs: 30_000 })
    return stdout.trim() !== '0'
  } catch {
    return true
  }
}

// The text of the one wake a watch sends: how its checks ended, a step back when one is due, and how long
// ago they finished. Pure, no engine access.

import type { Watch } from '../types'
import { incidentText } from './incident'
import { isResearchDue, researchText } from './rounds'
import { FAILED, PENDING } from './settle'

// How long ago the checks finished, so a late wake shows its delay.
function finishedAgo(watch: Watch, now?: number): string {
  if (now === undefined || watch.settledAt === undefined) return ''
  const minutes = Math.max(0, Math.round((now - watch.settledAt) / 60_000))
  return minutes === 0 ? ' Checks finished just now.' : ` Checks finished ${minutes} min ago.`
}

export function wakeText(watch: Watch, now?: number, red = 0): string {
  const pr = `${watch.repo}#${watch.number}`
  const isCounted = watch.outcome === 'failed' && watch.noVerdict === undefined
  const research = isCounted && isResearchDue(red) ? researchText(pr, red) : ''
  return `${outcomeText(watch, now, red)}${research}${finishedAgo(watch, now)}`
}

// Only the review failed, and no tier posted a 🔴: the code was not judged, so the round is not counted.
function noVerdictText(pr: string, title: string, red: number): string {
  return (
    `[ci-watch] ${pr}: the review gave no verdict (review gate: "${title}"), so this is no fix round and ` +
    `the count stays at ${red}. A review that cannot run (no account with room, a refused token or post, a ` +
    `cancelled run) is infrastructure: read the failing log, and re-run the review once its cause is gone.`
  )
}

function outcomeText(watch: Watch, now: number | undefined, red: number): string {
  const entries = Object.entries(watch.checks)
  const pr = `PR ${watch.repo}#${watch.number}`
  // Not settled: the wake names GitHub's incident while the checks wait.
  if (!watch.outcome && watch.incident) {
    const minutes = Math.round(((now ?? watch.startedAt) - watch.startedAt) / 60_000)
    return incidentText(pr, minutes, watch.incident)
  }
  const failed = entries.filter(([, bucket]) => FAILED.has(bucket)).map(([name]) => name)
  if (watch.outcome === 'failed' && watch.noVerdict !== undefined) return noVerdictText(pr, watch.noVerdict, red)
  if (watch.outcome === 'failed') {
    return (
      `[ci-watch] ${pr}: all checks settled; failed: ${failed.join(', ')}. Fetch the failing logs (gh run ` +
      `view --log-failed) or the review comment, fix and push; the watch restarts on the new commit.`
    )
  }
  if (watch.outcome === 'timeout') {
    const pending = entries.filter(([, bucket]) => PENDING.has(bucket)).map(([name]) => name)
    return (
      `[ci-watch] ${pr}: still pending after the time limit: ${pending.join(', ') || 'no checks reported'}. ` +
      `Look at why before waiting longer.`
    )
  }
  return (
    `[ci-watch] ${pr}: all ${entries.length} checks settled with no failure. Verify it is mergeable and ` +
    `finish it per the project rules.`
  )
}

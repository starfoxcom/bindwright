// The text of the one wake a watch sends: how its checks ended, a step back when one is due, and how long
// ago they finished. Pure, no engine access.

import type { Watch } from '../types'
import { isNoCi } from './checks'
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
  // A latched step back asks for research too: a streak that jumped past the 3rd round never lands on it.
  const isStepBack = isResearchDue(red) || watch.stepBackTopics !== undefined
  const research = isCounted && isStepBack ? researchText(pr, red) : ''
  // No check finished on a watch settled for a repo without CI or for a deep review that never started.
  const finished = isNoCi(watch) || watch.deepNeverStarted ? '' : finishedAgo(watch, now)
  return `${outcomeText(watch, now, red)}${research}${finished}`
}

// Only the review failed, because a review run never got to post its review: the code was not judged, so the round is
// not counted.
function noVerdictText(pr: string, tiers: string, red: number): string {
  return (
    `[ci-watch] ${pr}: the review never got to post (review gate: ${tiers}), so this is no fix round and ` +
    `the count stays at ${red}. A review that cannot run (no account with room, a refused token or post, a ` +
    `cancelled run) is infrastructure: read the failing log, re-run the review once its cause is gone, then ` +
    `call the watch tool on this PR, so the re-run's verdict counts as this head's round.`
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
  if (isNoCi(watch)) {
    return (
      `[ci-watch] ${pr}: the repo runs no CI workflows and the PR shows no check, so nothing will ` +
      `settle and no other wake comes. Check the PR yourself (gh pr view) and finish it per the project rules.`
    )
  }
  if (watch.deepNeverStarted) {
    return (
      `[ci-watch] ${pr}: the review gate waits for a deep review (needs-deep-review is on), but none ` +
      `started for this PR since the gate's first run, so the gate would stay pending. Re-run the routine ` +
      `review's run on this head (gh run rerun <its id>) so it asks again, then call the watch tool on this PR.`
    )
  }
  if (watch.outcome === 'timeout') {
    const pending = entries.filter(([, bucket]) => PENDING.has(bucket)).map(([name]) => name)
    return (
      `[ci-watch] ${pr}: still pending after the time limit: ${pending.join(', ') || 'no checks reported'}. ` +
      `Look at why before waiting longer.`
    )
  }
  if (watch.isConflicting) {
    return (
      `[ci-watch] ${pr}: the ${entries.length} checks that ran passed, but the PR conflicts with its base ` +
      `branch, so GitHub starts no other check until that is fixed and this is no fix round. Merge the base ` +
      `branch in, settle the conflicts and push; the watch restarts on the new commit.`
    )
  }
  return (
    `[ci-watch] ${pr}: all ${entries.length} checks settled with no failure. Verify it is mergeable and ` +
    `finish it per the project rules.`
  )
}

// The fix-round count: how many pushed rounds in a row a PR has had that did not merge: their checks did
// not all pass (both reviews included), or they passed and another push followed instead of the merge.
// At the 3rd, the 5th and every one from the 6th on, the red wake asks for a step back:
// research how others solve the problem, simplify, then go on. Each step back that leaves the PR red
// leaves one round fewer before the next; there is no last one. The red wake that asks for a step back
// also latches it on the watch: the session's edits, commits and pushes wait until five distinct web
// lookups ran (`withTopic`), so the fix comes after the research. The
// 10th red round is the hard stop: the PR is closed without merging and rebuilt from its base branch in a
// new PR, and the session's commits and pushes wait until it is closed. A round is a watch of
// a pushed head that settled (the session's own push, or a PR it asked to watch; never a head someone
// else pushed, which ci-watch follows silently): what ci-watch itself saw, never rebuilt from the
// branch's history (a merge, amend or rebase reshapes that), so pushes from another machine are not
// counted. Nor is a settle whose only failure is a review run that never got to post its review (`verdict.ts`): the
// code was not judged. Pure, no engine access.

import type { Watch } from '../types'

/** One settled watch of a PR's pushed head: whether a check failed. */
export type Round = { sha: string; red: boolean }
/** Whether a value read from the count file is one round: a head's sha and whether it failed. */
export function isRound(value: unknown): value is Round {
  const r = value as Partial<Round> | null
  return typeof r === 'object' && r !== null && typeof r.sha === 'string' && typeof r.red === 'boolean'
}

/** A PR's rounds, oldest first. */
export type PrRounds = { rounds: Round[] }

const KEPT = 50

/** The PR's rounds with one more settled watch, each kept as its checks ended. A watch of a head already
 * on the list (a re-run) replaces that round. */
export function recordRound(pr: PrRounds | undefined, sha: string, red: boolean): PrRounds {
  const earlier = (Array.isArray(pr?.rounds) ? pr.rounds : []).filter(r => r.sha !== sha)
  return { rounds: [...earlier, { sha, red }].slice(-KEPT) }
}

/** The red rounds in a row. A round is green only when the PR merges at its head, so while the newest
 * round failed, every earlier one counts red too: one that passed was still followed by another push, for
 * a conflict or any other reason. A newest round that passed is green until another head follows it. */
export function redStreak(pr: PrRounds | undefined): number {
  const rounds = Array.isArray(pr?.rounds) ? pr.rounds : []
  return rounds.at(-1)?.red ? rounds.length : 0
}

/** Which round head `sha` is for its PR, counting from 1: the one after every other head's round, where
 * `recordRound` puts it, so a head pushed again after later rounds counts as the newest, and no further
 * than the rounds it keeps. */
export function roundOf(pr: PrRounds | undefined, sha: string): number {
  const rounds = Array.isArray(pr?.rounds) ? pr.rounds : []
  return Math.min(rounds.filter(r => r.sha !== sha).length + 1, KEPT)
}

/** Whether a watch's head is, or may still become, one round of the count: the session's own push, not
 * conflicting with its base, and judged on its code. A settled one counts once its checks passed or failed. */
export function mayBeRound(w: Watch): boolean {
  const judged = w.outcome === undefined || w.outcome === 'passed' || w.outcome === 'failed'
  return !w.isSilent && !w.isConflicting && w.noVerdict === undefined && judged
}

/** The count's file, `{ "<owner/name>#<number>": PrRounds }`, written by the mod as watches settle and
 * spared by the sweep (it is named by no session). */
export const ROUNDS_FILE = 'rounds.json'

/** Whether a red streak this long calls for the research step: at 3, 5, then every round from 6. */
export const isResearchDue = (red: number) => red === 3 || red >= 5

/** Whether recording the round of head `sha` crossed a research step. A round that passed turns red once
 * another head follows it, so the streak can jump (0 to 4) and step over the 3rd without landing on it.
 * The rounds before are read without `sha`, and every round is stored as its checks ended, so a head
 * recorded again (a re-read, a second session) crosses the same step again. From the 5th on every red
 * round is due. */
export function crossedResearch(before: PrRounds | undefined, sha: string, after: PrRounds): boolean {
  const others = (Array.isArray(before?.rounds) ? before.rounds : []).filter(r => r.sha !== sha)
  const streak = redStreak(after)
  if (streak >= 5) return true
  for (let red = redStreak({ rounds: others }) + 1; red <= streak; red++) {
    if (isResearchDue(red)) return true
  }
  return false
}

/** How many more red rounds until the next research step: to 3, then to 5, then the next one. */
export const roundsToResearch = (red: number) => (red < 3 ? 3 : red < 5 ? 5 : red + 1) - red

/** The red streak that ends a PR: it is closed without merging and rebuilt in a new PR. */
export const HARD_STOP = 10

export const isHardStop = (red: number) => red >= HARD_STOP

/** `/ci-watch rounds`' answer for PR `pr`. While the newest round passed it waits for its merge, and the
 * forecast is for a red round after it, which counts every stored round as well as itself. */
export function roundsText(pr: string, stored: PrRounds | undefined): string {
  const red = redStreak(stored)
  const rounds = Array.isArray(stored?.rounds) ? stored.rounds : []
  if (red === 0 && rounds.length > 0) {
    const next = recordRound(stored, '', true)
    const count = redStreak(next)
    const then = isHardStop(count)
      ? 'that is the hard stop: close it and rebuild it in a new PR.'
      : crossedResearch(stored, '', next) ? 'that red round asks for a step back.' : 'no step back is due then.'
    return `${pr}: the newest round passed and waits for its merge. If the next round is red instead, that ` +
      `makes ${count} round(s) in a row that did not merge; ${then}`
  }
  const count = `${pr}: ${red} round(s) in a row that did not merge`
  if (isHardStop(red)) return `${count}; that is the hard stop: close it and rebuild it in a new PR.`
  return `${count}; the next step back is due in ${roundsToResearch(red)}.`
}

const REBUILD =
  'close it without merging (`gh pr close` with a comment that says why), then rebuild the change from its ' +
  "base branch in a new PR, with this round's findings fixed in the rebuild and a `Rebuilds #<old number>` " +
  'line in its body; the new PR starts its own count.'

export function researchText(pr: string, red: number): string {
  const after = isHardStop(red)
    ? `That is the hard stop: ${REBUILD} Commits and pushes wait until ${pr} is closed.`
    : `The next step back comes after ${roundsToResearch(red)} more red round(s).`
  return (
    ` ${pr} has had ${red} rounds in a row that did not merge: a check failed, both reviews included, or ` +
    'they all passed and another push followed instead of the merge. Before ' +
    'the next fix, step back: look up at least five different ways the community solves this problem ' +
    '(web search), compare them against each other, pick the simplest design that removes the whole class ' +
    'of findings rather than the next one, tell the user in plain words which option won and why, then ' +
    `apply it and keep going. ${after}`
  )
}

export function hardStopRefusal(pr: string, red: number): string {
  return (
    `${pr} has had ${red} red rounds in a row, the hard stop, so commits and pushes wait until it is ` +
    `closed: ${REBUILD}`
  )
}

/** Distinct web lookups a step back takes: one source is a guess, and five compared widen the search. */
export const SOURCES_NEEDED = 5

/** What a tool call looked up, when it is a web lookup of the main session: a WebSearch's query, a WebFetch's
 * URL or a web-fetch agent's brief. A subagent's own calls are not: a web-fetch agent is one lookup, not its
 * pages. Undefined for any other call. */
export function lookupTopic(e: unknown): string | undefined {
  const input = e as {
    tool?: unknown; subagent_type?: unknown; query?: unknown; url?: unknown; prompt?: unknown; agentId?: unknown
  }
  if (input.agentId !== undefined) return undefined
  if (input.tool === 'Agent' && input.subagent_type !== 'web-fetch') return undefined
  return String(input.query ?? input.url ?? input.prompt ?? '')
}

/** A watch's latched step back, carried onto the watch that replaces it. */
export function stepBackOf(w: Watch): Pick<Watch, 'stepBackTopics' | 'stepBackNeeded'> {
  return { stepBackTopics: w.stepBackTopics, stepBackNeeded: w.stepBackNeeded }
}

/** A latched step back's topics with one more lookup, lower-cased and trimmed, a repeat counted once;
 * undefined once `needed` distinct topics were looked up, which ends the step back. */
export function withTopic(topics: readonly string[], topic: string, needed = SOURCES_NEEDED): string[] | undefined {
  const clean = topic.trim().toLowerCase()
  const next = clean && !topics.includes(clean) ? [...topics, clean] : [...topics]
  return next.length >= needed ? undefined : next
}

export function researchRefusal(
  pr: string, red: number, needed = SOURCES_NEEDED, topics: readonly string[] = [],
): string {
  const owed = needed - topics.length
  return (
    `${pr} has had ${red} red rounds in a row, so edits, commits and pushes wait for a step back. Look up ` +
    `at least ${needed} different ways others solved this class of problem (${owed} more to go; ` +
    'each WebSearch, WebFetch or web-fetch agent call on a new topic counts once), compare them against ' +
    'each other, pick the one that removes the whole class most simply, tell the user which one won and ' +
    'why, then make the fix. Where web tools cannot run in this session, only the user can lift the hold, ' +
    'with /ci-watch stop.'
  )
}

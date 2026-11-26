// The fix-round count: how many pushed rounds in a row a PR has had that did not merge: their checks did
// not all pass (both reviews included), or they passed and another push followed instead of the merge.
// Every red round's wake asks for a step back: research how others solve the problem, simplify, then go
// on. It also latches the step back on the watch: the session's edits, commits and pushes wait until five
// distinct web lookups ran (`withTopic`), so the fix comes after the research. The first round gets the
// same research before the PR opens (`prCreateRefusal`). The
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

/** The red streak that ends a PR: it is closed without merging and rebuilt in a new PR. */
export const HARD_STOP = 10

export const isHardStop = (red: number) => red >= HARD_STOP

/** `/ci-watch rounds`' answer for PR `pr`. While the newest round passed it waits for its merge, and the
 * forecast is for a red round after it, which counts every stored round as well as itself. */
export function roundsText(pr: string, stored: PrRounds | undefined): string {
  const red = redStreak(stored)
  const rounds = Array.isArray(stored?.rounds) ? stored.rounds : []
  if (red === 0 && rounds.length > 0) {
    const count = redStreak(recordRound(stored, '', true))
    const then = isHardStop(count)
      ? 'that is the hard stop: close it and rebuild it in a new PR.'
      : 'that red round asks for a step back.'
    return `${pr}: the newest round passed and waits for its merge. If the next round is red instead, that ` +
      `makes ${count} round(s) in a row that did not merge; ${then}`
  }
  const count = `${pr}: ${red} round(s) in a row that did not merge`
  if (isHardStop(red)) return `${count}; that is the hard stop: close it and rebuild it in a new PR.`
  return `${count}; every red round asks for a step back.`
}

const REBUILD =
  'close it without merging (`gh pr close` with a comment that says why), then rebuild the change from its ' +
  "base branch in a new PR, with this round's findings fixed in the rebuild and a `Rebuilds #<old number>` " +
  'line in its body; the new PR starts its own count.'

export function researchText(pr: string, red: number): string {
  const after = isHardStop(red)
    ? ` That is the hard stop: ${REBUILD} Commits and pushes wait until ${pr} is closed.`
    : ''
  return (
    ` ${pr} has had ${red} round${red === 1 ? '' : 's'} in a row that did not merge: a check failed, both ` +
    'reviews included, or they all passed and another push followed instead of the merge. Before ' +
    'the next fix, step back: look up at least five different ways the community solves this problem ' +
    '(web search), compare them against each other, pick the simplest design that removes the whole class ' +
    'of findings rather than the next one, tell the user in plain words which option won and why, then ' +
    `apply it and keep going.${after}`
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

/** The refusal for opening a PR before its first round's research: `topics`, the distinct lookups since
 * the session last opened one. */
export function prCreateRefusal(topics: readonly string[]): string {
  return (
    `Opening a PR waits for its first round's research. Look up at least ${SOURCES_NEEDED} different ways ` +
    `others solved this problem (${SOURCES_NEEDED - topics.length} more to go; each WebSearch, WebFetch or ` +
    'web-fetch agent call on a new topic since the last PR opened counts once), compare them, build the ' +
    'change on the simplest one that removes the whole class, tell the user which one won and why, then ' +
    'open the PR. Where web tools cannot run in this session, the user opens it.'
  )
}

export function researchRefusal(
  pr: string, red: number, needed = SOURCES_NEEDED, topics: readonly string[] = [],
): string {
  const owed = needed - topics.length
  return (
    `${pr} has had ${red} red round${red === 1 ? '' : 's'} in a row, so edits, commits and pushes wait for ` +
    'a step back. Look up ' +
    `at least ${needed} different ways others solved this class of problem (${owed} more to go; ` +
    'each WebSearch, WebFetch or web-fetch agent call on a new topic counts once), compare them against ' +
    'each other, pick the one that removes the whole class most simply, tell the user which one won and ' +
    'why, then make the fix. Where web tools cannot run in this session, only the user can lift the hold, ' +
    'with /ci-watch stop.'
  )
}

// The fix-round count: how many pushed rounds in a row a PR has had whose checks did not all pass (both
// reviews included). At the 3rd, the 5th and every one from the 6th on, the red wake asks for a step back:
// research how others solve the problem, simplify, then go on. Each step back that leaves the PR red
// leaves one round fewer before the next. A push to the PR is refused while a step back is due and no web
// research has run since its last red round settled (`isResearchOwed`). A round is a watch of
// a pushed head that settled (the session's own push, or a PR it asked to watch; never a head someone
// else pushed, which ci-watch follows silently): what ci-watch itself saw, never rebuilt from the
// branch's history (a merge, amend or rebase reshapes that), so pushes from another machine are not
// counted. Pure, no engine access.

/** One settled watch of a PR's pushed head: whether a check failed. */
export type Round = { sha: string; red: boolean; at?: number }
/** A PR's rounds, oldest first. */
export type PrRounds = { rounds: Round[] }

const KEPT = 50

/** The PR's rounds with one more settled watch. A watch of a head already on the list (a re-run) replaces
 * that round. */
export function recordRound(pr: PrRounds | undefined, sha: string, red: boolean, at?: number): PrRounds {
  const rounds = (Array.isArray(pr?.rounds) ? pr.rounds : []).filter(r => r.sha !== sha)
  return { rounds: [...rounds, at === undefined ? { sha, red } : { sha, red, at }].slice(-KEPT) }
}

/** The rounds in a row, newest first, that had a failed check, back to the last one that passed. */
export function redStreak(pr: PrRounds | undefined): number {
  const rounds = Array.isArray(pr?.rounds) ? pr.rounds : []
  let red = 0
  for (let i = rounds.length - 1; i >= 0 && rounds[i]?.red; i--) red++
  return red
}

/** The count's file, `{ "<owner/name>#<number>": PrRounds }`, written by the mod as watches settle and
 * spared by the sweep (it is named by no session). */
export const ROUNDS_FILE = 'rounds.json'

/** Whether a red streak this long calls for the research step: at 3, 5, then every round from 6. */
export const isResearchDue = (red: number) => red === 3 || red >= 5

/** How many more red rounds until the next research step: to 3, then to 5, then the next one. */
export const roundsToResearch = (red: number) => (red < 3 ? 3 : red < 5 ? 5 : red + 1) - red

export function researchText(pr: string, red: number): string {
  return (
    ` ${pr} has had ${red} fix rounds in a row without every check green, both reviews included. Before ` +
    'the next fix, step back: research how the community solves this problem and what options exist (web ' +
    'search), pick the simplest design that removes the whole class of findings rather than the next one, ' +
    'tell the user in plain words what changes and why, then apply it and keep going. The next step back ' +
    `comes after ${roundsToResearch(red)} more red round(s).`
  )
}

/** Whether a push to the PR must wait for research: a step back is due and no web research ran after its
 * last red round settled (`researchedAt`, ms; 0 when none). A round saved without its time counts as
 * settled at 0, so any research covers it. */
export function isResearchOwed(pr: PrRounds | undefined, researchedAt: number): boolean {
  const red = redStreak(pr)
  if (!isResearchDue(red)) return false
  const last = (Array.isArray(pr?.rounds) ? pr.rounds : []).at(-1)
  return researchedAt <= (typeof last?.at === 'number' ? last.at : 0)
}

export function researchRefusal(pr: string, red: number): string {
  return (
    `${pr} has had ${red} red rounds in a row, so this push waits for a step back. Research first: ` +
    'search the web (WebSearch or WebFetch) for how others solved this class of problem, pick the ' +
    'simplest design that removes the whole class, tell the user what changes and why, then push.'
  )
}

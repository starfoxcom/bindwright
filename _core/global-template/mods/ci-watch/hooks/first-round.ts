// A PR opens only after its first round's research: the distinct web lookups the main session ran since it
// last opened one. Memory only, so a restarted session researches again. No engine access.

import { isPrCreate } from './command'
import { prCreateRefusal, SOURCES_NEEDED, withTopic } from './rounds'

const counted = { topics: [] as string[] }

/** One more web lookup of the main session, counted once per topic, up to the ones a PR needs. */
export function noteFirstRoundLookup(topic: string): void {
  counted.topics = withTopic(counted.topics, topic, SOURCES_NEEDED + 1) ?? counted.topics
}

const isOpening = (agentId: unknown, command: string, isPowerShell: boolean) =>
  agentId === undefined && isPrCreate(command, isPowerShell)

/** The refusal for a main-session `gh pr create` that comes before its research, or undefined. */
export function openingRefusal(agentId: unknown, command: string, isPowerShell: boolean): string | undefined {
  const isEarly = isOpening(agentId, command, isPowerShell) && counted.topics.length < SOURCES_NEEDED
  return isEarly ? prCreateRefusal(counted.topics) : undefined
}

/** A main-session `gh pr create` went through: the next PR waits for research of its own. */
export function noteOpened(agentId: unknown, command: string, isPowerShell: boolean): void {
  if (isOpening(agentId, command, isPowerShell)) counted.topics = []
}

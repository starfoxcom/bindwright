import type { Mirror, MirrorTask } from './mirror'

// Keep going: a turn that ends while a task on the list needs no one gets a prompt to carry on, so an
// unattended run never sits idle with work left that nobody has to wait for. Pure, no engine access:
// register.ts decides when to look and sends the prompt.

/** Prompts in a row, with no change to the task list between them, before the mod stops asking. */
export const MAX_IDLE_PROMPTS = 2

/** Context fill, against the auto-compaction point, from which a turn's end counts as near the compaction:
 * where the session-facts row turns yellow. Sessions ended turns there on a next step they announced. */
export const NEAR_COMPACTION = 0.75

export function isNearCompaction(tokens: number | undefined, compactsAt: number | undefined): boolean {
  return tokens !== undefined && compactsAt !== undefined && compactsAt > 0 && tokens / compactsAt >= NEAR_COMPACTION
}

/** The tasks the model can work on now: open, not on hold, not waiting on another open task. */
export function workable(mirror: Mirror): MirrorTask[] {
  const isOpen = (task: MirrorTask) => task.status !== 'completed' && !task.droppedAt
  const openIds = new Set(mirror.tasks.filter(isOpen).map(task => task.id))
  const ready = mirror.tasks.filter(
    task => isOpen(task) && !task.hold && !(task.blockedBy ?? []).some(id => openIds.has(id)),
  )
  // The one in progress first: it is the work the turn stopped in.
  const isStarted = (task: MirrorTask) => task.status === 'in_progress'
  return [...ready.filter(isStarted), ...ready.filter(task => !isStarted(task))]
}

type WatchFields = { outcome?: string; wakePending?: boolean; settledAt?: number; pushedAt?: number }

/**
 * How long a push to a settled watch's PR counts as pending. Right after a push GitHub can still name the old
 * head, so ci-watch only stamps the settled watch and restarts it on the new head at its next poll (under a
 * minute). A push that moved no commit never restarts it: past this, it is no wake.
 */
export const PUSH_RESTART_MS = 5 * 60_000

const isPushedSinceSettled = (watch: WatchFields, now: number) =>
  watch.pushedAt !== undefined &&
  watch.settledAt !== undefined &&
  watch.pushedAt > watch.settledAt &&
  now - watch.pushedAt <= PUSH_RESTART_MS

/**
 * What is still coming that wakes the session on its own: a CI watch not yet settled or not yet sent, or one
 * pushed to again a moment ago.
 */
export function hasPendingWake(ciWatchState: string | undefined, now = 0): boolean {
  if (!ciWatchState) return false
  try {
    const watches = (JSON.parse(ciWatchState) as { watches?: WatchFields[] }).watches
    return (watches ?? []).some(watch => !watch.outcome || watch.wakePending || isPushedSinceSettled(watch, now))
  } catch {
    return false
  }
}

/**
 * What the engine's Stop event says will wake the session on its own: background work still in flight (a
 * shell job run in the background, a subagent, a monitor) or a scheduled wake (`/loop`, a cron, a wakeup).
 */
export function hasEngineWake(stop: { background_tasks?: unknown[]; session_crons?: unknown[] }): boolean {
  return (stop.background_tasks?.length ?? 0) > 0 || (stop.session_crons?.length ?? 0) > 0
}

/**
 * A plan-limit pause that still holds the session until its wake: active (usage-guard wakes it), or
 * cancelled (the person declined any automatic resume before the reset). A pause whose wake passed while no
 * session was open stays "active" on disk until one starts; past its wake, neither holds anything back.
 */
export function isPauseHolding(pauseFile: string | undefined, now: number): boolean {
  if (!pauseFile) return false
  try {
    const pause = JSON.parse(pauseFile) as { status?: string; wakeAt?: number }
    const isHeld = pause.status === 'active' || pause.status === 'cancelled'
    return isHeld && typeof pause.wakeAt === 'number' && pause.wakeAt > now
  } catch {
    return false
  }
}

export function keepGoingText(tasks: readonly MirrorTask[]): string {
  const [first, ...rest] = tasks
  const more = rest.length > 0 ? ` (and ${rest.length} more with no hold)` : ''
  return (
    `[tasks] The turn ended with nothing pending to wake the session, and task #${first?.id} ` +
    `"${first?.subject}"${more} needs no one. Continue it now. If it waits on a person, a decision or ` +
    'another task, put it on hold with what it waits on; if it is done, mark it completed.'
  )
}

export function nearCompactionText(): string {
  return (
    '[tasks] The turn ended near the compaction with nothing pending to wake the session and no task on ' +
    'the list to carry on. The compaction carries the context across, so it is no reason to stop: go on ' +
    'now with the step this turn announced or left open. Only if the work truly waits on a person, say ' +
    'what it waits on and end the turn.'
  )
}

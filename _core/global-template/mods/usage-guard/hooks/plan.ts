import type { SessionRateLimit } from 'claude-code'

import type { ArmedWake } from '../types'

// The pause and arm decisions and the texts they send, kept free of the engine so they test alone.

// One shared file tells every session on the machine that a pause is on, so
// a session that never crossed the line itself still wraps up. Which sessions
// have wrapped up is kept as claims beside it (see `claim`), never in this file,
// so no two sessions rewrite it at once.
export type Pause = {
  status: 'active' | 'done' | 'cancelled'
  kinds: string[]
  percentUsed: number
  resetsAt: string
  wakeAt: number
  triggeredBy: string
  /** Each paused limit's own reset, by kind: `resetsAt` is only the latest of them. Missing in older files. */
  resets?: Record<string, string>
  /** Its wake was brought forward by an early reset: it covers no plan, since the fence drops stale readings. */
  isBroughtForward?: boolean
  /** The reset the first pause of this run named. Kept when a later limit extends the pause, so the
   * wrap-up, stop and resume claims (keyed on it) still run once per session. */
  episode?: string
}

export const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

/** The kind of an arm set for a time of day (`/usage-guard arm 21:05`) rather than a plan window's reset. */
export const CLOCK = 'clock'
/** The longest reason an arm carries to its wake, in characters. */
export const REASON_MAX = 300

/** What an arm waits for, as the texts say it: "after the 5-hour reset", or "at the time you set". */
export function armFor(kind: string): string {
  return kind === CLOCK ? 'at the time you set' : `after the ${LIMIT_NAMES[kind] ?? kind} reset`
}

/** The line that hands an arm's reason to the session it wakes. */
export function reasonText(reason: string): string {
  return `The reason this wake was set with: "${reason}".`
}

/**
 * The project's close-session skill among `commands`: its current name first, then the name a
 * project set up before the rename still has; undefined when it has neither.
 */
export function closeCommand(commands: readonly { name: string }[]): string | undefined {
  return ['close-session', 'session-close'].find(name => commands.some(command => command.name === name))
}

export const WRAP_UP_ARGS =
  'Plan usage limit nearly reached (automatic wrap-up). Commit locally only: no push, no PR, no CI. ' +
  'Save the hand-off so the work can resume after the reset, stop every background task and monitor, ' +
  'keep it short.'

// What every wake submits: to a session the person armed by hand, or to one the pause resumes because it
// saved work at its wrap-up. Only the plan approval is waived, the one stop `/start-session` would add;
// every step a project's rules keep for the person still waits for them. A wrap-up ends in a compaction
// or a /clear more often than not, hence the hand-off.
export function resumePrompt(reason: string): string {
  return (
    `[usage-guard] ${reason} Continue the pending work now; do not wait for a plan approval, this resume is ` +
    'automatic. If this conversation does not hold the work, rebuild it first from the newest hand-off, the ' +
    "task list and git. Every step the project's rules keep for the person (a push, a PR or merge, a visual " +
    'check, anything destructive) still stops and waits for them.'
  )
}

// What a session hears at the reset when no saved work is on record under its id. Never "saved no work":
// a wrap-up whose claim failed before a hot reload, or one before a /clear, left work and no record.
export const NO_WORK_NOTICE =
  'Plan limits have reset. No saved work is on record for this session, so it does not go on by itself; ' +
  'pick up a hand-off by hand, for example with /start-session (or /session-start).'

export function hotLimits(limits: readonly SessionRateLimit[], wrapUpAt: number): SessionRateLimit[] {
  return limits.filter(limit => limit.resetsAt !== undefined && limit.percentUsed >= wrapUpAt)
}

export function planPause(hot: readonly SessionRateLimit[], delayMinutes: number, sessionId: string): Pause {
  const latest = [...hot].sort((a, b) => Date.parse(b.resetsAt ?? '') - Date.parse(a.resetsAt ?? ''))[0]
  const resetsAt = latest?.resetsAt ?? ''
  return {
    status: 'active',
    kinds: hot.map(limit => limit.kind),
    percentUsed: Math.max(...hot.map(limit => limit.percentUsed)),
    resetsAt,
    resets: Object.fromEntries(hot.map(limit => [limit.kind, limit.resetsAt ?? ''])),
    wakeAt: Date.parse(resetsAt) + delayMinutes * 60_000,
    triggeredBy: sessionId,
  }
}

const ARM_KINDS: Record<string, string> = { '5h': 'five_hour', week: 'seven_day' }

// The wake `/usage-guard arm <5h|week>` sets: the named window's next reset plus the resume delay,
// whatever its usage, or why there is none. A reading can carry a reset already past (check() skips
// those too); that one is no reset to wait for.
export function planArm(
  limits: readonly SessionRateLimit[],
  which: string,
  delayMinutes: number,
  now: number,
): ArmedWake | string {
  const kind = ARM_KINDS[which]
  if (!kind) return 'Name the reset to wake at: /usage-guard arm 5h or /usage-guard arm week.'
  const resetsAt = limits.find(limit => limit.kind === kind)?.resetsAt
  // Written as "not later" so a reset time that does not parse (NaN) is refused too.
  if (!resetsAt || !(Date.parse(resetsAt) > now))
    return `No ${LIMIT_NAMES[kind]} reset is known yet, so there is nothing to arm.`
  return { kind, resetsAt, wakeAt: Date.parse(resetsAt) + delayMinutes * 60_000 }
}

export function limitName(pause: Pause): string {
  return pause.kinds.map(kind => LIMIT_NAMES[kind] ?? kind.replace(/_/g, '-')).join(' + ')
}

// Claims under mods-data/usage-guard/claims/. `mkdir` is atomic, so of several
// sessions acting on one pause at the same moment exactly one wins each claim:
// `pause-<reset>`, the session that writes the pause and stops its project's
// background work; `<reset>-<session>`, that session has wrapped up (or, opened
// during the pause, only waits); `work-<reset>-<session>`, it wrapped up with
// work, so it resumes by itself. The helper also makes the claims folder, which
// the engine's fs cannot, and sweeps claims older than two weeks.
export const CLAIM =
  'const fs=require("fs"),p=require("path");const [d,n]=process.argv.slice(1);' +
  'const c=p.join(d,"claims");fs.mkdirSync(c,{recursive:true});' +
  'for(const x of fs.readdirSync(c)){try{const f=p.join(c,x);' +
  'if(Date.now()-fs.statSync(f).mtimeMs>12096e5)fs.rmSync(f,{recursive:true})}catch{}}' +
  'try{fs.mkdirSync(p.join(c,n));console.log("won")}' +
  'catch(e){if(e.code!=="EEXIST")throw e;console.log("taken")}'

export const resetKey = (pause: Pause) => String(Date.parse(pause.episode ?? pause.resetsAt))

/** How much later than the pause's own reset a window must reset to count as a new window. */
const NEW_WINDOW_MS = 60 * 60_000

/**
 * A pause, active or cancelled and before its wake, whose every limit now reads under the wrap-up line in a
 * new window: the plan reset early (a banked reset, for one), so the pause holds nothing anymore. A window
 * counts as new only when it resets well after that limit's own paused reset, so a session's older reading
 * of the same window never ends a pause.
 */
export function isResetEarly(pause: Pause, limits: readonly SessionRateLimit[], wrapUpAt: number, now: number) {
  const isHolding = (pause.status === 'active' || pause.status === 'cancelled') && pause.wakeAt > now
  const isClear = (kind: string) => {
    const limit = limits.find(item => item.kind === kind)
    const resetsAt = Date.parse(limit?.resetsAt ?? '')
    const pausedUntil = pausedReset(pause, kind)
    return limit !== undefined && limit.percentUsed < wrapUpAt && resetsAt - pausedUntil >= NEW_WINDOW_MS
  }
  return isHolding && pause.kinds.length > 0 && pause.kinds.every(isClear)
}

/**
 * The pause to write when `judged` is brought forward to `now`, or undefined when the file changed since it was
 * read: a cancel or an extension another session wrote meanwhile wins over the early end.
 */
export function bringForward(judged: Pause, current: Pause | undefined, now: number): Pause | undefined {
  if (!current || JSON.stringify(current) !== JSON.stringify(judged)) return undefined
  return { ...current, wakeAt: now, isBroughtForward: true }
}

/** When a limit the pause covers was set to reset, in ms; NaN for a limit it does not cover. */
export function pausedReset(pause: Pause, kind: string): number {
  return pause.kinds.includes(kind) ? Date.parse(pause.resets?.[kind] ?? pause.resetsAt) : NaN
}

// A pause that already reaches a planned reset: the plan is part of it. Weekly usage only falls at its
// reset, so a fresh reading after an extension plans that later reset; an earlier one is a stale reading.
// A pause brought forward covers nothing: the fence already dropped every reading of the windows it paused.
export function covers(pause: Pause | undefined, planned: Pause): boolean {
  if (pause?.isBroughtForward) return false
  return pause !== undefined && Date.parse(planned.resetsAt) <= Date.parse(pause.resetsAt)
}

/**
 * Per limit kind, the latest reset of a window that ended early. A reading of that window or an older one is
 * stale (an idle session keeps its last reading), so it never plans a pause, whatever pause the file holds.
 */
export type Fence = Record<string, string>

/** The fence after `pause` ended early: each of its limits fenced at its paused reset, the later one kept. */
export function fenceAfter(fence: Fence, pause: Pause): Fence {
  const next = { ...fence }
  for (const kind of pause.kinds) {
    const reset = pause.resets?.[kind] ?? pause.resetsAt
    if (!(Date.parse(reset) <= Date.parse(next[kind] ?? ''))) next[kind] = reset
  }
  return next
}

/** The limits whose window resets after its fence: fresh readings, and every limit with no fence. */
export function unfenced(limits: readonly SessionRateLimit[], fence: Fence): SessionRateLimit[] {
  return limits.filter(limit => !(Date.parse(limit.resetsAt ?? '') <= Date.parse(fence[limit.kind] ?? '')))
}

// A pause another session wrote since this one read the file: joined, never replaced. A later reset
// extends it in place and keeps its episode, so no session wraps up or stops its work twice.
export function joinPause(shared: Pause, planned: Pause): Pause {
  if (Date.parse(planned.resetsAt) <= Date.parse(shared.resetsAt)) return shared
  return {
    ...shared,
    resetsAt: planned.resetsAt,
    wakeAt: planned.wakeAt,
    kinds: [...new Set([...shared.kinds, ...planned.kinds])],
    resets: { ...shared.resets, ...planned.resets },
    percentUsed: Math.max(shared.percentUsed, planned.percentUsed),
    episode: shared.episode ?? shared.resetsAt,
  }
}

// The whole path names the project: two repos may share a folder name (`~/work/app`, `~/clients/x/app`).
export function projectOf(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// Said when a session is armed with nothing pending: the wake-up would find no work to go on with.
export const EMPTY_ARM_NOTE =
  'Nothing is pending here (no open task that is not on hold), so the wake-up will have nothing to do. ' +
  'Keep it, or cancel it with /usage-guard disarm.'

// The open tasks in the tasks mod's copy of a session's list: not completed, not dropped, not on hold. A
// task on hold waits on the person, so waking for it only says it still waits. Undefined when unreadable.
export function countOpenTasks(text: string): number | undefined {
  try {
    const { tasks } = JSON.parse(text) as { tasks?: { status?: string; hold?: string; droppedAt?: number }[] }
    if (!Array.isArray(tasks)) return undefined
    return tasks.filter(task => task.status !== 'completed' && !task.hold && task.droppedAt === undefined).length
  } catch {
    return undefined
  }
}

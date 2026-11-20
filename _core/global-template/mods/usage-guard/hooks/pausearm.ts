import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { dataDir, readJson } from './files'
import { live } from './live'
import { type DisarmAll, isDisarmedByAll, type Pause, resetKey } from './plan'

// This session's own resume at a pause's wake: the pause arms every session it holds, and a disarm here cancels
// this session's resume alone. It is kept apart from the arm set by hand, which says when the person wants the
// session back. It lives in plugin state, so a hot reload keeps it, and in the session's pause claim folder
// (`claims/<reset>-<session>/arm.json`), so a restart finds it; a session that met the pause under an earlier
// version has the claim and no file, and is armed when it next sees the pause.

export type PauseArm = {
  /** The pause's reset key (`resetKey`): an extended pause keeps it. */
  key: string
  resetsAt: string
  wakeAt: number
  /** When it was set, in ms: a disarm of every session after it declines it. */
  setAt: number
  /** The session saved work at the wrap-up, so its wake resumes something. */
  hasWork?: boolean
  /** The person cancelled this session's resume: the pause never arms it again. */
  isDeclined?: boolean
}

const pauseArm = atom({ plugin: 'usage-guard', key: 'pauseArm' } as const, null)

async function pauseArmPath($: EngineInterface, key: string): Promise<string> {
  return `${await dataDir($)}/claims/${key}-${await $.session.id()}/arm.json`
}

// The saved copy: undefined when there is none (never armed, or met under an earlier version).
async function readSavedPauseArm($: EngineInterface, key: string): Promise<PauseArm | null | undefined> {
  const text = await $.fs.read(await pauseArmPath($, key)).catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const arm = JSON.parse(String(text)) as PauseArm | null
    return arm && arm.key === key && typeof arm.wakeAt === 'number' ? arm : null
  } catch {
    return null
  }
}

async function savePauseArm($: EngineInterface, arm: PauseArm): Promise<void> {
  await update($, pauseArm, () => arm)
  // A claim folder the helper could not make leaves the arm in state alone, as before saved arms existed.
  await $.fs.write(await pauseArmPath($, arm.key), JSON.stringify(arm, null, 2)).catch(() => undefined)
}

export async function readPauseArm($: EngineInterface): Promise<PauseArm | null> {
  return read($, pauseArm)
}

/**
 * Arms this session for the pause's wake, or follows the pause to a later wake when another session extended it.
 * A declined arm stays declined: the pause never undoes the person's cancel, after a /clear or a restart either.
 */
export async function armForPause(
  $: EngineInterface,
  pause: Pause,
  hasWork: boolean,
  onWake: (resetsAt: string) => Promise<void>,
): Promise<void> {
  const key = resetKey(pause)
  const now = await $.clock.now()
  const held = await read($, pauseArm)
  const found = held?.key === key ? held : await readSavedPauseArm($, key)
  // A saved null is an arm already declined, or one done with.
  if (found === null) return
  const arm = found ?? { key, resetsAt: pause.resetsAt, wakeAt: pause.wakeAt, setAt: now, hasWork }
  if (arm.isDeclined) return void (held?.key === key ? undefined : await update($, pauseArm, () => arm))
  if (isDisarmedByAll(arm, await readDisarmAll($))) return declinePauseArm($)
  const next = { ...arm, resetsAt: pause.resetsAt, wakeAt: pause.wakeAt, hasWork: Boolean(arm.hasWork || hasWork) }
  if (JSON.stringify(next) !== JSON.stringify(held)) await savePauseArm($, next)
  if (live.wakeTimer && held?.wakeAt === next.wakeAt) return
  live.wakeTimer?.cancel()
  live.wakeTimer = $.clock.after(Math.max(0, next.wakeAt - now), () => {
    live.wakeTimer = undefined
    void wakeFromPause($, next, onWake).catch(() => undefined)
  })
}

// At the wake: unless a disarm of every session came after it, the pause resumes this session.
async function wakeFromPause($: EngineInterface, arm: PauseArm, onWake: (resetsAt: string) => Promise<void>) {
  const current = await read($, pauseArm)
  if (current?.key !== arm.key || current.isDeclined) return
  if (isDisarmedByAll(current, await readDisarmAll($))) return declinePauseArm($)
  await update($, pauseArm, () => null)
  await onWake(current.resetsAt)
}

/** Ends this session's resume now that the pause's wake came early: true when it held one to end. */
export async function takePauseArm($: EngineInterface, pause: Pause): Promise<boolean> {
  const current = await read($, pauseArm)
  if (current?.key !== resetKey(pause) || current.isDeclined) return false
  live.wakeTimer?.cancel()
  live.wakeTimer = undefined
  await update($, pauseArm, () => null)
  return true
}

/** Cancels this session's resume at the pause's wake; the arm it declines, or undefined when none stood. */
export async function declinePauseArm($: EngineInterface): Promise<PauseArm | undefined> {
  const current = await read($, pauseArm)
  if (!current || current.isDeclined) return undefined
  live.wakeTimer?.cancel()
  live.wakeTimer = undefined
  await savePauseArm($, { ...current, isDeclined: true })
  return current
}

async function readDisarmAll($: EngineInterface): Promise<DisarmAll | undefined> {
  return readJson<DisarmAll>($, `${await dataDir($)}/disarm.json`)
}

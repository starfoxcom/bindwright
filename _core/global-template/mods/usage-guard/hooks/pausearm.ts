import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PauseArm } from '../types'
import { readMark } from './armstore'
import { dataDir } from './files'
import { live } from './live'
import { isDisarmedByAll, type Pause, resetKey } from './plan'

// This session's own resume at a pause's wake: the pause arms every session it holds, and a disarm here cancels
// this session's resume alone. It is kept apart from the arm set by hand, which says when the person wants the
// session back. It lives in plugin state, so a hot reload keeps it, and in the session's pause claim folder
// (`claims/<reset>-<session>/arm.json`), so a restart finds it; a session that met the pause under an earlier
// version has the claim and no file, and is armed when it next sees the pause.

const pauseArm = atom({ plugin: 'usage-guard', key: 'pauseArm' } as const, null)

async function pauseArmPath($: EngineInterface, key: string, session?: string): Promise<string> {
  return `${await dataDir($)}/claims/${key}-${session ?? (await $.session.id())}/arm.json`
}

// The saved copy: undefined when there is none (never armed, or met under an earlier version), null when it cannot
// be read, which leaves the session un-armed, as a saved hand arm that cannot be read does.
async function readSavedPauseArm($: EngineInterface, key: string, session?: string) {
  const text = await $.fs.read(await pauseArmPath($, key, session)).catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const arm = JSON.parse(String(text)) as PauseArm | null
    return arm && arm.key === key && typeof arm.wakeAt === 'number' ? arm : null
  } catch {
    return null
  }
}

/** Whether a session cancelled its resume at this pause's wake: its saved work is then offered to no other session. */
export async function isPauseResumeDeclined($: EngineInterface, key: string, session: string): Promise<boolean> {
  return Boolean((await readSavedPauseArm($, key, session))?.isDeclined)
}

async function savePauseArm($: EngineInterface, arm: PauseArm): Promise<void> {
  await update($, pauseArm, () => arm)
  // Under this session's id, for a restart, and under the one it was first filed under, where the offer of its saved
  // work looks. A claim folder the helper could not make leaves the arm in state alone, as before saved arms existed.
  const paths = new Set([await pauseArmPath($, arm.key), await pauseArmPath($, arm.key, arm.session)])
  for (const path of paths) await $.fs.write(path, JSON.stringify(arm, null, 2)).catch(() => undefined)
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
  // A saved copy that cannot be read leaves the session un-armed.
  if (found === null) return
  const fresh: PauseArm = { key, resetsAt: pause.resetsAt, wakeAt: pause.wakeAt, setAt: now, hasWork }
  const arm = found ?? { ...fresh, session: await $.session.id() }
  if (arm.isDeclined) return keepDeclined($, arm, held)
  if (isDisarmedByAll(arm, await readMark($, 'disarm'))) return void (await declinePauseArm($))
  const next = { ...arm, resetsAt: pause.resetsAt, wakeAt: pause.wakeAt, hasWork: Boolean(arm.hasWork || hasWork) }
  if (JSON.stringify(next) !== JSON.stringify(held)) await savePauseArm($, next)
  // Against this module's own timer: after a hot reload the shared state may already hold a wake set by the other.
  if (live.wakeTimer && live.wakeTimerAt === next.wakeAt) return
  live.wakeTimer?.cancel()
  live.wakeTimerAt = next.wakeAt
  live.wakeTimer = $.clock.after(Math.max(0, next.wakeAt - now), () => {
    live.wakeTimer = undefined
    void wakeFromPause($, next, onWake).catch(() => undefined)
  })
}

// A cancelled resume found in state is saved under this session's id too, so a restart after a /clear keeps it.
async function keepDeclined($: EngineInterface, arm: PauseArm, held: PauseArm | null): Promise<void> {
  if (held?.key !== arm.key) return void (await update($, pauseArm, () => arm))
  if ((await readSavedPauseArm($, arm.key)) === undefined) await savePauseArm($, arm)
}

// At the wake this timer was set for: unless a disarm of every session came after it, the pause resumes this session.
async function wakeFromPause($: EngineInterface, arm: PauseArm, onWake: (resetsAt: string) => Promise<void>) {
  const current = await read($, pauseArm)
  if (current?.key !== arm.key || current.wakeAt !== arm.wakeAt || current.isDeclined) return
  if (isDisarmedByAll(current, await readMark($, 'disarm'))) return declinePauseArm($)
  await update($, pauseArm, () => null)
  await onWake(arm.resetsAt)
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


import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { type Account, isLiftedBySwitch, readAccount } from './account'
import { readMark } from './armstore'
import { readPause, writeEpisode, writePause } from './files'
import { live } from './live'
import { bringForward, naturalKey, type Pause } from './plan'
import { notice } from './say'

// A /login to another account, seen from this session: the pause it made on the old account, the account its own
// plan readings belong to, and the card about an arm set by hand.

const armedWake = atom({ plugin: 'usage-guard', key: 'armed' } as const, null)
const accountView = atom({ plugin: 'usage-guard', key: 'account' } as const, null)

/** What a check knows of the login: the account signed in, and whether this session's readings are its. */
export type SwitchSeen = { account: Account | undefined; isFresh: boolean; now: number }

// A switch to an account with room ends a pause made on another one, as an early reset does, but without a fence:
// the old account's windows did not reset, and its readings already plan nothing once they are not fresh.
export async function endIfSwitched($: EngineInterface, pause: Pause, seen: SwitchSeen): Promise<Pause> {
  const { rateLimits } = await $.session.usage().catch(() => ({ rateLimits: [] }))
  if (!isLiftedBySwitch(pause, seen.account, rateLimits, { ...seen, wrapUpAt: live.wrapUpAt })) return pause
  const current = await readPause($)
  const forward = bringForward(pause, current, seen.now)
  if (!forward) return current ?? pause
  const lifted = { ...forward, isAccountLift: true }
  await writePause($, lifted)
  // Named from the lift's own wake, which every session reads alike.
  const ended = { episode: new Date(lifted.wakeAt).toISOString(), key: naturalKey(pause) }
  if (pause.account) await writeEpisode($, pause.account, ended)
  await notice($, `Signed in with an account that has room left (${seen.account?.label}): the pause ends now.`)
  return lifted
}

/**
 * The account signed in, and whether this session's plan readings are that account's: true before any turn of
 * this session ended under a login it could read. A login that cannot be read then proves nothing (the file may be
 * mid-write), so readings already tied to an account are not fresh; with none ever tied (no login), they are.
 */
export async function seeLogin($: EngineInterface, now: number): Promise<SwitchSeen> {
  const account = await readAccount($)
  const reading = (await read($, accountView))?.reading
  return { account, isFresh: !reading || reading === account?.id, now }
}

/** The card about an arm set by hand that a switch held back when it ended the pause, for the arm at `wakeAt`. */
export async function raiseSwitchCard($: EngineInterface, wakeAt: number): Promise<void> {
  const label = (await readAccount($))?.label ?? 'another account'
  await update($, accountView, view => ({ ...view, reading: view?.reading ?? null, card: { label, wakeAt } }))
}

/** Readings from a turn a /login in another session cut across: tied to no account, so never fresh. */
const STRADDLED = 'straddled-a-switch'

// The login a turn began under: its readings are an account's only when the turn also ended under it.
export async function noteTurnStart($: EngineInterface): Promise<void> {
  const id = (await readAccount($))?.id ?? null
  await update($, accountView, view => ({ reading: view?.reading ?? null, card: view?.card ?? null, turnLogin: id }))
}

// At a turn's end this session's plan readings are the signed-in account's, when the turn began under it too. A
// login that cannot be read then leaves the account they were last known to be.
export async function noteReading($: EngineInterface): Promise<void> {
  const id = (await readAccount($))?.id
  await update($, accountView, view => {
    const began = view?.turnLogin
    const isStraddled = id !== undefined && typeof began === 'string' && began !== id
    return { reading: isStraddled ? STRADDLED : (id ?? view?.reading ?? null), card: view?.card ?? null }
  })
}

export async function clearSwitchCard($: EngineInterface): Promise<void> {
  await update($, accountView, view => (view ? { ...view, card: null } : view))
}

/** A lift of every session reached this one: its arm set by hand before the lift is due now, unless a pause holds. */
export async function isLiftAsked($: EngineInterface, pause: Pause | undefined, now: number): Promise<boolean> {
  const arm = await read($, armedWake)
  if (!arm || arm.wakeAt <= now) return false
  const mark = await readMark($, 'lift')
  const isHeld = pause?.status === 'active' && pause.wakeAt > now
  return mark !== undefined && (arm.setAt ?? 0) < mark.at && !isHeld
}

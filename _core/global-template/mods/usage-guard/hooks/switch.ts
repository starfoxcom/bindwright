import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { type Account, isLiftedBySwitch, readAccount } from './account'
import { readMark } from './armstore'
import { readPause, writePause } from './files'
import { live } from './live'
import { bringForward, type Pause } from './plan'
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
  await notice($, `Signed in with an account that has room left (${seen.account?.label}): the pause ends now.`)
  return lifted
}

/** The account signed in, and whether this session's plan readings are that account's (true with no login). */
export async function seeLogin($: EngineInterface, now: number): Promise<SwitchSeen> {
  const account = await readAccount($)
  const isFresh = !account || (await read($, accountView))?.reading === account.id
  return { account, isFresh, now }
}

// The account this session saw last. After a switch, a session holding an arm set by hand shows a card about it
// (the first sight of an account, at a start, is no switch).
export async function meetSwitch($: EngineInterface, seen: SwitchSeen): Promise<void> {
  const { account, now } = seen
  const view = await read($, accountView)
  if (!account || view?.seen === account.id) return
  const arm = await read($, armedWake)
  const isHeld = Boolean(view?.seen) && arm !== null && !arm.isAuto && arm.wakeAt > now
  const card = isHeld && arm ? { label: account.label, wakeAt: arm.wakeAt } : (view?.card ?? null)
  await update($, accountView, () => ({ seen: account.id, reading: view?.reading ?? null, card }))
}

// At a turn's end this session's plan readings are the signed-in account's.
export async function noteReading($: EngineInterface): Promise<void> {
  const id = (await readAccount($))?.id ?? null
  await update($, accountView, view => ({ seen: view?.seen ?? id, reading: id, card: view?.card ?? null }))
}

export async function clearSwitchCard($: EngineInterface): Promise<void> {
  await update($, accountView, view => (view ? { ...view, card: null } : view))
}

/** A lift of every session reached this one: its arm set by hand before the lift is due now, unless a pause holds. */
export async function isLiftAsked($: EngineInterface, pause: Pause | undefined, now: number): Promise<boolean> {
  const arm = await read($, armedWake)
  if (!arm || arm.isAuto || arm.wakeAt <= now) return false
  const mark = await readMark($, 'lift')
  const isHeld = pause?.status === 'active' && pause.wakeAt > now
  return mark !== undefined && (arm.setAt ?? 0) < mark.at && !isHeld
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { type Account, isLiftedBySwitch, readAccount } from './account'
import { readMark } from './armstore'
import { readFence, readPause, writeFence, writePause } from './files'
import { live } from './live'
import { bringForward, fenceAfter, type Pause } from './plan'
import { notice } from './say'

// A /login to another account, seen from this session: the pause it made on the old account, and the card about an
// arm set by hand.

const armedWake = atom({ plugin: 'usage-guard', key: 'armed' } as const, null)
const accountView = atom({ plugin: 'usage-guard', key: 'account' } as const, null)

/** What a check knows of the login: the account signed in. */
export type SwitchSeen = { account: Account | undefined; now: number }

// A switch to an account with room ends a pause made on another one as an early reset does, fence included. Plan
// readings carry no account, so a session the new login has not reached yet still reads the old account's windows:
// the fence drops those readings, whatever login they came under, until the windows reset.
export async function endIfSwitched($: EngineInterface, pause: Pause, seen: SwitchSeen): Promise<Pause> {
  // Most checks see no switch at all: read the plan figures only when one may have happened.
  if (!pause.account || !seen.account || seen.account.id === pause.account) return pause
  const { rateLimits } = await $.session.usage().catch(() => ({ rateLimits: [] }))
  if (!isLiftedBySwitch(pause, seen.account, rateLimits, { ...seen, wrapUpAt: live.wrapUpAt })) return pause
  const current = await readPause($)
  const forward = bringForward(pause, current, seen.now)
  if (!forward) return current ?? pause
  const lifted = { ...forward, isAccountLift: true }
  await writePause($, lifted)
  await writeFence($, fenceAfter(await readFence($), lifted))
  await notice($, `Signed in with an account that has room left (${seen.account.label}): the pause ends now.`)
  return lifted
}

export async function seeLogin($: EngineInterface, now: number): Promise<SwitchSeen> {
  return { account: await readAccount($), now }
}

/** The card about an arm set by hand that a switch held back when it ended the pause, for the arm at `wakeAt`. */
export async function raiseSwitchCard($: EngineInterface, wakeAt: number): Promise<void> {
  const label = (await readAccount($))?.label ?? 'another account'
  await update($, accountView, () => ({ card: { label, wakeAt } }))
}

export async function clearSwitchCard($: EngineInterface): Promise<void> {
  await update($, accountView, view => (view ? { ...view, card: null } : view))
}

/** How long a lift of every session counts: every running session checks within a minute. */
const LIFT_MARK_MS = 5 * 60_000

/** A lift of every session reached this one: its arm set by hand before the lift is due now, unless a pause holds. */
export async function isLiftAsked($: EngineInterface, pause: Pause | undefined, now: number): Promise<boolean> {
  const arm = await read($, armedWake)
  if (!arm || arm.wakeAt <= now) return false
  const mark = await readMark($, 'lift')
  const isHeld = pause?.status === 'active' && pause.wakeAt > now
  // Only sessions running when it was pressed: a session opened days later never starts work from an old press.
  const isRecent = mark !== undefined && now - mark.at <= LIFT_MARK_MS
  return mark !== undefined && isRecent && (arm.setAt ?? 0) < mark.at && !isHeld
}

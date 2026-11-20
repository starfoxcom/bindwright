import { type Engine, expect, test } from 'claude-code/testing'
import { pickOffer } from '../hooks/arms'
import {
  CARD_FILE,
  CLAIMS_DIR,
  doWork,
  endTurn,
  KEY,
  mountCard,
  NOW,
  pauseOf,
  RESET,
  resumes,
  start,
  WAKE,
  world,
  type World,
} from './world'

// A pause arms every session it holds with a resume of its own, so one session's resume can be cancelled alone.

const LONG = { timeoutMs: 15_000 }
const DISARM_FILE = 'C:/Users/me/.claude/mods-data/usage-guard/disarm.json'
const PAUSE_ARM_FILE = `${CLAIMS_DIR}/${KEY}-sess-a/arm.json`
const HOT = [{ kind: 'five_hour', percentUsed: 97, resetsAt: RESET }]
const pauseArmOf = (seen: World) => JSON.parse(seen.files.get(PAUSE_ARM_FILE) ?? 'null')

async function pauseWithWork($: Engine, seen: World): Promise<void> {
  await start($)
  await doWork($)
  seen.limits = HOT
  await endTurn($)
}

test("a disarm cancels only this session's resume; its saved work is offered nowhere", LONG, async ($, on) => {
  const seen = world(on)
  await pauseWithWork($, seen)
  expect(pauseArmOf(seen)).toEqual(expect.objectContaining({ wakeAt: WAKE, hasWork: true }))

  const answer = await $.command.run({ command: 'usage-guard', args: 'disarm' } as never)
  expect(answer.text).toContain('Disarmed')
  expect(pauseArmOf(seen)?.isDeclined).toBe(true)
  // Its resume is taken as handled, so a later session never offers the work as a closed session's.
  expect(seen.claims.has(`resume-${KEY}-sess-a`)).toBe(true)
  expect(pauseOf(seen)?.status).toBe('active')
  await seen.clock.advance(WAKE - NOW)
  expect(resumes(seen)).toEqual([])
})

test('the pause card cancels the resume of the session it shows in, or of all', LONG, async ($, on) => {
  const seen = world(on)
  await pauseWithWork($, seen)
  const ui = await mountCard($)
  await seen.clock.advance(2_000)
  await ui.press({ key: 'usage-disarm-here' })

  expect(pauseArmOf(seen)?.isDeclined).toBe(true)
  expect(pauseOf(seen)?.status).toBe('active')
  await ui.press({ key: 'usage-cancel' })
  expect(pauseOf(seen)?.status).toBe('cancelled')
})

test('a disarm holds after a /clear and after a restart', LONG, async ($, on) => {
  const seen = world(on)
  await pauseWithWork($, seen)
  await $.command.run({ command: 'usage-guard', args: 'disarm' } as never)
  seen.sessionId = 'sess-b'
  await seen.clock.advance(60_000)
  seen.sessionId = 'sess-a'
  await start($)
  await seen.clock.advance(WAKE - NOW)

  expect(resumes(seen)).toEqual([])
})

test("another session's disarm-global drops this session's arm at its next check", LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  seen.files.set(DISARM_FILE, JSON.stringify({ at: NOW + 1 }))
  await seen.clock.advance(60_000)

  await seen.clock.advance(WAKE - NOW)
  expect(resumes(seen)).toEqual([])
})

test('an arm set after a disarm-global stands', LONG, async ($, on) => {
  const seen = world(on)
  seen.files.set(DISARM_FILE, JSON.stringify({ at: NOW - 1 }))
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  await seen.clock.advance(WAKE - NOW)

  expect(resumes(seen)).toHaveLength(1)
})

test('disarm-global with no pause raises no card', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'disarm-global' } as never)

  expect(seen.files.has(CARD_FILE)).toBe(false)
})

test('a closed session\'s arm set before a disarm-global is not offered', () => {
  const arm = { kind: 'five_hour', resetsAt: RESET, wakeAt: NOW - 10 * 60_000, root: 'C:/Repos/my-game', setAt: 1 }
  const files = [{ name: 'sess-b.json', text: JSON.stringify(arm) }]
  expect(pickOffer(files, 'sess-a', 'C:/Repos/my-game', NOW)?.owner).toBe('sess-b')
  expect(pickOffer(files, 'sess-a', 'C:/Repos/my-game', NOW, { at: 2 })).toBeUndefined()
})

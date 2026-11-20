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
  PAUSE_FILE,
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
  expect(pauseOf(seen)?.status).toBe('active')
  await seen.clock.advance(WAKE - NOW)
  expect(resumes(seen)).toEqual([])
})

test('an arm set by hand after a disarm still resumes the session at the reset, once', LONG, async ($, on) => {
  const seen = world(on)
  await pauseWithWork($, seen)
  await $.command.run({ command: 'usage-guard', args: 'disarm' } as never)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  await seen.clock.advance(WAKE - NOW + 60_000)

  expect(resumes(seen)).toHaveLength(1)
})

test('a session that met the pause under an earlier version is armed knowing it saved work', LONG, async ($, on) => {
  const seen = world(on)
  const window = { kinds: ['five_hour'], resetsAt: RESET, wakeAt: WAKE }
  const saved = { ...window, session: 'sess-a', root: 'C:/Repos/my-game', key: KEY }
  const pause = { ...window, status: 'active', percentUsed: 97, triggeredBy: 'x' }
  seen.files.set(PAUSE_FILE, JSON.stringify(pause))
  seen.files.set(`${CLAIMS_DIR}/work-${KEY}-sess-a/saved.json`, JSON.stringify(saved))
  seen.claims.add(`${KEY}-sess-a`)
  await start($)
  await seen.clock.advance(60_000)

  expect(pauseArmOf(seen)).toEqual(expect.objectContaining({ wakeAt: WAKE, hasWork: true }))
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
  // Saved under the new id too, so a restart into it finds the cancel.
  const underNewId = JSON.parse(seen.files.get(PAUSE_ARM_FILE.replace('sess-a', 'sess-b')) ?? 'null')
  expect(underNewId?.isDeclined).toBe(true)
  seen.sessionId = 'sess-a'
  await start($)
  await seen.clock.advance(WAKE - NOW)

  expect(resumes(seen)).toEqual([])
})

test('a disarm after a /clear marks the resume declined where its saved work is filed', LONG, async ($, on) => {
  const seen = world(on)
  await pauseWithWork($, seen)
  seen.sessionId = 'sess-b'
  await seen.clock.advance(60_000)
  await $.command.run({ command: 'usage-guard', args: 'disarm' } as never)

  expect(pauseArmOf(seen)?.isDeclined).toBe(true)
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

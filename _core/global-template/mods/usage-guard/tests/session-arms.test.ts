import { expect, test } from 'claude-code/testing'
import {
  ARM_FILE,
  cardOf,
  doWork,
  endTurn,
  mountCard,
  NOW,
  pauseOf,
  RESET,
  resumes,
  start,
  WAKE,
  world,
} from './world'

// A pause arms every session it holds with an arm of its own, so one session's resume can be cancelled alone.

const LONG = { timeoutMs: 15_000 }
const DISARM_FILE = 'C:/Users/me/.claude/mods-data/usage-guard/disarm.json'
const HOT = [{ kind: 'five_hour', percentUsed: 97, resetsAt: RESET }]

test('a pause arms the session, and a disarm there cancels only its resume', LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await doWork($)
  seen.limits = HOT
  await endTurn($)

  const saved = JSON.parse(seen.files.get(ARM_FILE) ?? 'null')
  expect(saved).toEqual(expect.objectContaining({ wakeAt: WAKE, isAuto: true }))
  const answer = await $.command.run({ command: 'usage-guard', args: 'disarm' } as never)
  expect(answer.text).toContain('Disarmed')
  // The pause stands for every other session.
  expect(pauseOf(seen)?.status).toBe('active')
  await seen.clock.advance(WAKE - NOW)
  expect(resumes(seen)).toEqual([])
})

test('the pause card cancels the resume of the session it shows in, or of all', LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await doWork($)
  seen.limits = HOT
  await endTurn($)
  const ui = await mountCard($)
  await seen.clock.advance(2_000)
  await ui.press({ key: 'usage-disarm-here' })

  expect(seen.files.get(ARM_FILE)).toBe('null')
  expect(pauseOf(seen)?.status).toBe('active')
  expect(cardOf(seen)?.id).toBe(`paused:${RESET}`)
  await ui.press({ key: 'usage-cancel' })
  expect(pauseOf(seen)?.status).toBe('cancelled')
})

test("another session's disarm-global drops this session's arm at its next check", LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  seen.files.set(DISARM_FILE, JSON.stringify({ at: NOW + 1 }))
  await seen.clock.advance(60_000)

  expect(seen.files.get(ARM_FILE)).toBe('null')
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

test('a session that disarmed during a pause is not armed again when it starts again', LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await doWork($)
  seen.limits = HOT
  await endTurn($)
  await $.command.run({ command: 'usage-guard', args: 'disarm' } as never)
  await start($)

  expect(seen.files.get(ARM_FILE)).toBe('null')
  await seen.clock.advance(WAKE - NOW)
  expect(resumes(seen)).toEqual([])
})

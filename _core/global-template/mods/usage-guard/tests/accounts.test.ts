import { type Engine, expect, test } from 'claude-code/testing'
import { accountOf } from '../hooks/account'
import { CARD_FILE, doWork, endTurn, mountCard, NOW, PAUSE_FILE, pauseOf, quietWakes, RESET, resumes } from './world'
import { start, TASKS_DIR, WAKE, world, type World } from './world'

// Two accounts on one computer: a pause belongs to the account it was made on, and a /login to one with room
// lifts the arms the pause set, while an arm set by hand waits for the person.

const LONG = { timeoutMs: 15_000 }
const CONFIG = 'C:/Users/me/.claude.json'
const LIFT_FILE = 'C:/Users/me/.claude/mods-data/usage-guard/lift.json'
const HOT = [{ kind: 'five_hour', percentUsed: 97, resetsAt: RESET }]
// The other account's own window: low, and resetting at another time.
const ROOMY = [{ kind: 'five_hour', percentUsed: 10, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() }]

function signIn(seen: World, id: string, planDisplayName = 'Ultra'): void {
  seen.files.set(CONFIG, JSON.stringify({ oauthAccount: { accountUuid: id, planDisplayName } }))
}

const LABELS: [string, object, string | undefined][] = [
  ['the plan name the login gives', { accountUuid: 'a', planDisplayName: 'Ultra' }, 'Ultra'],
  [
    'a Max tier read from the type and tier',
    { accountUuid: 'a', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' },
    'Max 5x',
  ],
  ['a plan type with no tier', { accountUuid: 'a', organizationType: 'claude_pro' }, 'Pro'],
  ['no account id', { planDisplayName: 'Ultra' }, undefined],
]
for (const [name, login, label] of LABELS) {
  test(`account label: ${name}`, () => {
    expect(accountOf(JSON.stringify({ oauthAccount: login }))?.label).toBe(label)
  })
}

test('a switch to an account with room ends the pause and resumes the saved work', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await doWork($)
  seen.limits = HOT
  await endTurn($)
  expect(pauseOf(seen)?.account).toBe('acct-ultra')

  signIn(seen, 'acct-max', 'Max')
  seen.limits = ROOMY
  await endTurn($)
  await seen.clock.advance(1_000)

  expect(pauseOf(seen)?.isAccountLift).toBe(true)
  expect(resumes(seen)).toHaveLength(1)
  // No window reset: the resume says what ended the pause.
  expect(resumes(seen)[0]).toContain('Signed in with an account that has room')
  const card = JSON.parse(seen.files.get(CARD_FILE) ?? '{}')
  expect(card.text).toBe('Signed in with an account that has room. Sessions are resuming their saved work.')
})

test('a quiet wake lifted after a switch names the switch, not a reset', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  seen.hasTasksMod = true
  seen.files.set(`${TASKS_DIR}/${seen.sessionId}.json`, JSON.stringify({ session: seen.sessionId, tasks: [] }))
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  seen.limits = HOT
  await endTurn($)
  signIn(seen, 'acct-max', 'Max')
  seen.limits = ROOMY
  await endTurn($)
  await seen.clock.advance(1_000)
  await (await mountCard($)).press({ key: 'usage-lift-here' })
  await seen.clock.advance(1_000)

  expect(quietWakes(seen)).toHaveLength(1)
  expect(quietWakes(seen)[0]).toContain('after the switch to an account with room')
})

test('a whole turn under the new login that still reads the old account\'s windows plans no pause', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    await start($)
    await doWork($)
    seen.limits = HOT
    await endTurn($)
    signIn(seen, 'acct-max', 'Max')
    seen.limits = ROOMY
    await endTurn($)
    await seen.clock.advance(1_000)
    // The credentials reach this session late (the macOS keychain), or its turn made no request: the old figures.
    seen.limits = HOT
    await $.turn.start({ turnId: 't2' } as never)
    await endTurn($)
    await seen.clock.advance(61_000)

    expect(pauseOf(seen)?.status).not.toBe('active')
  })

test('after a switch, the new account\'s own window that resets earlier still pauses when it runs hot', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    await start($)
    await doWork($)
    seen.limits = HOT
    await endTurn($)
    // The other account's window resets half an hour before the spent one's.
    const earlier = new Date(Date.parse(RESET) - 30 * 60_000).toISOString()
    signIn(seen, 'acct-max', 'Max')
    seen.limits = [{ kind: 'five_hour', percentUsed: 40, resetsAt: earlier }]
    await endTurn($)
    await seen.clock.advance(1_000)
    seen.limits = [{ kind: 'five_hour', percentUsed: 96, resetsAt: earlier }]
    await endTurn($)

    expect([pauseOf(seen)?.status, pauseOf(seen)?.resetsAt, pauseOf(seen)?.account]).toEqual(['active', earlier,
      'acct-max'])
  })

test('after a cancelled pause, a switch leaves the old account\'s figures planning no pause', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await doWork($)
  seen.limits = HOT
  await endTurn($)
  await $.command.run({ command: 'usage-guard', args: 'disarm-global' } as never)
  // Signed in with the other account; this session's figures are still the old account's.
  signIn(seen, 'acct-max', 'Max')
  await $.turn.start({ turnId: 't2' } as never)
  await endTurn($)
  await seen.clock.advance(61_000)

  expect(pauseOf(seen)?.status).toBe('cancelled')
})

test('an arm set by hand waits after a switch, with a card that lifts it', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await endTurn($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h "check CI"' } as never)
  seen.limits = HOT
  await endTurn($)
  signIn(seen, 'acct-max', 'Max')
  seen.limits = ROOMY
  await endTurn($)
  await seen.clock.advance(1_000)

  // Ended, not left active with a past wake that a session opened now would read as a missed reset.
  expect([pauseOf(seen)?.isAccountLift, pauseOf(seen)?.status]).toEqual([true, 'done'])
  expect(resumes(seen)).toEqual([])
  const ui = await mountCard($)
  await ui.press({ key: 'usage-lift-here' })
  await seen.clock.advance(1_000)
  expect(resumes(seen)).toHaveLength(1)
  expect(resumes(seen)[0]).toContain('check CI')
})

// 10:05 in the world's zone, five minutes from now: the arm comes due while the pause holds, and moves onto its wake.
async function armDueInPause($: Engine, seen: World, hot = HOT): Promise<void> {
  signIn(seen, 'acct-ultra')
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 10:05 "check CI"' } as never)
  await doWork($)
  seen.limits = hot
  await endTurn($)
  await seen.clock.advance(6 * 60_000)
}

async function switchToRoomy($: Engine, seen: World, limits = ROOMY): Promise<void> {
  signIn(seen, 'acct-max', 'Max')
  seen.limits = limits
  await endTurn($)
  await seen.clock.advance(1_000)
}

test('an arm whose time came during the pause resumes at a switch', LONG, async ($, on) => {
  const seen = world(on)
  await armDueInPause($, seen)
  await switchToRoomy($, seen)

  expect(resumes(seen)).toHaveLength(1)
})

test('an arm whose time came during a pause extended since resumes once at a switch', LONG, async ($, on) => {
  const seen = world(on)
  // A window resetting 20 minutes from now, so the arm's old wake comes soon after the switch.
  const near = new Date(NOW + 20 * 60_000).toISOString()
  await armDueInPause($, seen, [{ kind: 'five_hour', percentUsed: 97, resetsAt: near }])
  // Another session joined a weekly limit: the pause now runs to a later reset under the same episode.
  const later = new Date(NOW + 3_600_000).toISOString()
  const extended = { ...pauseOf(seen), resetsAt: later, wakeAt: Date.parse(later) + 120_000, episode: near }
  seen.files.set(PAUSE_FILE, JSON.stringify({ ...extended, kinds: ['five_hour', 'seven_day'] }))
  const week = { kind: 'seven_day', percentUsed: 10, resetsAt: new Date(NOW + 5 * 24 * 3_600_000).toISOString() }
  await switchToRoomy($, seen, [...ROOMY, week])
  await seen.clock.advance(20 * 60_000)

  expect(resumes(seen)).toHaveLength(1)
})

test('a session armed by hand at a time of day still resumes its saved work when lifted after a switch', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    // No open task: only the work saved at the wrap-up makes the wake a resume and not a quiet "the wake came".
    seen.hasTasksMod = true
    seen.files.set(`${TASKS_DIR}/${seen.sessionId}.json`, JSON.stringify({ session: seen.sessionId, tasks: [] }))
    await start($)
    await $.command.run({ command: 'usage-guard', args: 'arm 23:30' } as never)
    await doWork($)
    seen.limits = HOT
    await endTurn($)
    signIn(seen, 'acct-max', 'Max')
    seen.limits = ROOMY
    await endTurn($)
    await seen.clock.advance(1_000)
    expect(resumes(seen)).toEqual([])

    await (await mountCard($)).press({ key: 'usage-lift-here' })
    await seen.clock.advance(1_000)
    expect(resumes(seen)).toHaveLength(1)
  })

test('a lifted arm leaves the next arm for the same reset its own resume', LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h "check CI"' } as never)
  await $.command.run({ command: 'usage-guard', args: 'lift' } as never)
  await seen.clock.advance(1_000)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h "check CI"' } as never)
  await seen.clock.advance(WAKE - NOW)

  expect(resumes(seen)).toHaveLength(2)
  // No reset came at the lift, and its resume does not say one did.
  expect(resumes(seen)[0]).toContain('The wake you armed, lifted early by hand, has come')
})

test('an arm held after a switch, moved onto the other account\'s pause, resumes once at its wake', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    await start($)
    await $.command.run({ command: 'usage-guard', args: 'arm 5h "check CI"' } as never)
    seen.limits = HOT
    await endTurn($)
    signIn(seen, 'acct-max', 'Max')
    seen.limits = ROOMY
    await endTurn($)
    await seen.clock.advance(1_000)
    // The other account runs hot too: its own pause holds when the held arm's wake comes.
    const otherReset = ROOMY[0]?.resetsAt ?? ''
    seen.limits = [{ kind: 'five_hour', percentUsed: 97, resetsAt: otherReset }]
    await endTurn($)
    await seen.clock.advance(Date.parse(otherReset) + 10 * 60_000 - NOW)

    expect(resumes(seen)).toHaveLength(1)
  })

test('an arm held after a switch fires under the claim an older instance of this module takes', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    await start($)
    await $.command.run({ command: 'usage-guard', args: 'arm 5h "check CI"' } as never)
    seen.limits = HOT
    await endTurn($)
    signIn(seen, 'acct-max', 'Max')
    seen.limits = ROOMY
    await endTurn($)
    await seen.clock.advance(1_000)
    // The instance a hot reload left on older code won the arm's claim first.
    seen.claims.add(`arm-${Date.parse(RESET)}-${seen.sessionId}`)
    await seen.clock.advance(WAKE - NOW)

    expect(resumes(seen)).toEqual([])
  })

test('a switch with no pause to end raises no card', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await endTurn($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  signIn(seen, 'acct-max', 'Max')
  await endTurn($)

  expect(await (await mountCard($)).find({ key: 'usage-switch' })).toBeUndefined()
})

test('a lift while a pause still holds keeps the arm at its own time', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 23:30' } as never)
  seen.limits = HOT
  await endTurn($)
  const answer = await $.command.run({ command: 'usage-guard', args: 'lift' } as never)
  await seen.clock.advance(1_000)

  expect(answer.text).toContain('A pause still holds')
  expect(resumes(seen)).toEqual([])
})

test('back on the spent account after a switch, only its next window pauses, with claims of its own', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    await start($)
    await doWork($)
    seen.limits = HOT
    await endTurn($)
    signIn(seen, 'acct-max', 'Max')
    seen.limits = ROOMY
    await endTurn($)
    await seen.clock.advance(1_000)
    signIn(seen, 'acct-ultra')
    seen.limits = HOT
    await endTurn($)
    await seen.clock.advance(WAKE - NOW)
    const before = resumes(seen).length
    // Later the next window runs hot with no switch in between.
    const nextReset = new Date(Date.parse(RESET) + 3_600_000).toISOString()
    await doWork($)
    seen.limits = [{ kind: 'five_hour', percentUsed: 97, resetsAt: nextReset }]
    await endTurn($)
    await seen.clock.advance(Date.parse(nextReset) + 10 * 60_000 - (WAKE + 1_000))

    expect([pauseOf(seen)?.resetsAt, pauseOf(seen)?.episode, resumes(seen).length]).toEqual([nextReset, undefined,
      before + 1])
  })

test('a switch to an account with another window running hot leaves the pause on', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await doWork($)
  seen.limits = HOT
  await endTurn($)
  signIn(seen, 'acct-max', 'Max')
  const weekHot = { kind: 'seven_day', percentUsed: 99, resetsAt: new Date(NOW + 2 * 24 * 3_600_000).toISOString() }
  seen.limits = [...ROOMY, weekHot]
  await endTurn($)
  await seen.clock.advance(1_000)

  expect([pauseOf(seen)?.isAccountLift, resumes(seen)]).toEqual([undefined, []])
})

test('a lift of every session wakes this session\'s arm set by hand at its next check', LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  seen.files.set(LIFT_FILE, JSON.stringify({ at: NOW + 1 }))
  await seen.clock.advance(61_000)

  expect(resumes(seen)).toHaveLength(1)
})

test('a lift of every session pressed long before this session saw it leaves the arm at its own time', LONG,
  async ($, on) => {
    const seen = world(on)
    await start($)
    await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
    await seen.clock.advance(10 * 60_000)
    seen.files.set(LIFT_FILE, JSON.stringify({ at: NOW + 1 }))
    await seen.clock.advance(61_000)

    expect(resumes(seen)).toEqual([])
  })

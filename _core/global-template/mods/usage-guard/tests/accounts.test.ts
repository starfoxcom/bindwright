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

test('an idle session holding the other account\'s readings leaves that account\'s new pause on', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    await start($)
    await endTurn($)
    signIn(seen, 'acct-max', 'Max')
    seen.limits = ROOMY
    await endTurn($)
    // Another session signed back in with the spent account and paused it again; this one stays idle.
    signIn(seen, 'acct-ultra')
    const pause = { status: 'active', kinds: ['five_hour'], percentUsed: 97, resetsAt: RESET, wakeAt: WAKE }
    seen.files.set(PAUSE_FILE, JSON.stringify({ ...pause, account: 'acct-ultra', triggeredBy: 'sess-b' }))
    await seen.clock.advance(61_000)

    expect([pauseOf(seen)?.status, pauseOf(seen)?.wakeAt]).toEqual(['active', WAKE])
  })

test('readings from before a switch plan no pause on the new account', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await endTurn($)
  // Another session signed in with the other account; this one's last readings are still the old account's.
  signIn(seen, 'acct-max', 'Max')
  seen.limits = HOT
  await seen.clock.advance(60_000)

  expect(pauseOf(seen)).toBeUndefined()
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

test('a login that cannot be read leaves this session\'s readings tied to their account', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await endTurn($)
  // Another session switched, and this check caught the file half-written.
  seen.files.set(CONFIG, '{"oauthAccount": {"accountUu')
  seen.limits = HOT
  await seen.clock.advance(60_000)

  expect(pauseOf(seen)).toBeUndefined()
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

test('back on the spent account after a switch, the sessions pause again as a new episode', LONG, async ($, on) => {
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
  const lifted = pauseOf(seen)
  signIn(seen, 'acct-ultra')
  seen.limits = HOT
  await endTurn($)

  // Named from the ended pause's wake, which every session reads alike, so all of them plan the same claims.
  const again = pauseOf(seen)
  const episode = lifted && new Date(lifted.wakeAt).toISOString()
  expect([again?.status, again?.isAccountLift, again?.episode]).toEqual(['active', undefined, episode])
})

test('back on the spent account after the other one paused and reset, the sessions pause again as a new episode', LONG,
  async ($, on) => {
    const seen = world(on)
    signIn(seen, 'acct-ultra')
    await start($)
    await doWork($)
    const weekReset = new Date(NOW + 3 * 24 * 3_600_000).toISOString()
    const weekHot = [{ kind: 'seven_day', percentUsed: 97, resetsAt: weekReset }]
    seen.limits = weekHot
    await endTurn($)
    signIn(seen, 'acct-max', 'Max')
    const otherWeek = { kind: 'seven_day', percentUsed: 5, resetsAt: new Date(NOW + 5 * 24 * 3_600_000).toISOString() }
    seen.limits = [...ROOMY, otherWeek]
    await endTurn($)
    await seen.clock.advance(1_000)
    const lifted = pauseOf(seen)
    expect(lifted?.isAccountLift).toBe(true)
    // The other account runs hot, pauses, and its window resets.
    const otherReset = ROOMY[0]?.resetsAt ?? ''
    seen.limits = [{ kind: 'five_hour', percentUsed: 97, resetsAt: otherReset }, otherWeek]
    await endTurn($)
    await seen.clock.advance(Date.parse(otherReset) + 10 * 60_000 - NOW)
    const later = new Date(NOW + 8 * 3_600_000).toISOString()
    seen.limits = [{ kind: 'five_hour', percentUsed: 5, resetsAt: later }, otherWeek]
    await endTurn($)
    signIn(seen, 'acct-ultra')
    seen.limits = weekHot
    await endTurn($)

    const again = pauseOf(seen)
    const episode = lifted && new Date(lifted.wakeAt).toISOString()
    expect([again?.status, again?.resetsAt, again?.episode]).toEqual(['active', weekReset, episode])
  })

test('after the re-pause on the spent account, its next window pauses and resumes with claims of its own', LONG,
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

test('another account\'s cancelled pause does not stand in for one on the spent account', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  seen.limits = HOT
  await endTurn($)
  signIn(seen, 'acct-max', 'Max')
  seen.limits = ROOMY
  await endTurn($)
  await seen.clock.advance(1_000)
  seen.limits = [{ kind: 'five_hour', percentUsed: 97, resetsAt: ROOMY[0]?.resetsAt ?? '' }]
  await endTurn($)
  await $.command.run({ command: 'usage-guard', args: 'disarm-global' } as never)
  signIn(seen, 'acct-ultra')
  seen.limits = HOT
  await endTurn($)

  expect([pauseOf(seen)?.status, pauseOf(seen)?.account]).toEqual(['active', 'acct-ultra'])
})

test('an arm held after a switch is not the re-pause\'s: it resumes at its own time, once', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  // 13:00 in the world's zone (UTC-7): 20:00 UTC, an hour after the paused window's reset.
  await $.command.run({ command: 'usage-guard', args: 'arm 13:00 "read the results"' } as never)
  seen.limits = HOT
  await endTurn($)
  signIn(seen, 'acct-max', 'Max')
  seen.limits = ROOMY
  await endTurn($)
  await seen.clock.advance(1_000)
  // Back on the spent account before its reset: the same window pauses again under a new episode.
  signIn(seen, 'acct-ultra')
  seen.limits = HOT
  await endTurn($)
  await seen.clock.advance(WAKE - NOW)
  const handed = () => seen.prompts.filter(text => text.includes('read the results'))
  expect(handed()).toEqual([])

  await seen.clock.advance(Date.UTC(2026, 9, 2, 20, 1) - WAKE)
  expect(handed()).toHaveLength(1)
})

test('readings from a turn another session\'s /login cut across plan no pause', LONG, async ($, on) => {
  const seen = world(on)
  signIn(seen, 'acct-ultra')
  await start($)
  await endTurn($)
  await $.turn.start({ turnId: 't2' } as never)
  // The turn's last answers came under the old account; the login changed before it ended.
  seen.limits = HOT
  signIn(seen, 'acct-max', 'Max')
  await endTurn($)
  await seen.clock.advance(60_000)

  expect(pauseOf(seen)).toBeUndefined()
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

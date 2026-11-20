import { expect, test } from 'claude-code/testing'
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

test('a lift of every session wakes this session\'s arm set by hand at its next check', LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  seen.files.set(LIFT_FILE, JSON.stringify({ at: NOW + 1 }))
  await seen.clock.advance(61_000)

  expect(resumes(seen)).toHaveLength(1)
})

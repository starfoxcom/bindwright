import { expect, test } from 'claude-code/testing'
import { accountOf } from '../hooks/account'
import { doWork, endTurn, mountCard, NOW, pauseOf, RESET, resumes, start, world, type World } from './world'

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

  expect(pauseOf(seen)?.isAccountLift).toBe(true)
  expect(resumes(seen)).toEqual([])
  const ui = await mountCard($)
  await ui.press({ key: 'usage-lift-here' })
  await seen.clock.advance(1_000)
  expect(resumes(seen)).toHaveLength(1)
  expect(resumes(seen)[0]).toContain('check CI')
})

test('a lift of every session wakes this session\'s arm set by hand at its next check', LONG, async ($, on) => {
  const seen = world(on)
  await start($)
  await $.command.run({ command: 'usage-guard', args: 'arm 5h' } as never)
  seen.files.set(LIFT_FILE, JSON.stringify({ at: NOW + 1 }))
  await seen.clock.advance(61_000)

  expect(resumes(seen)).toHaveLength(1)
})

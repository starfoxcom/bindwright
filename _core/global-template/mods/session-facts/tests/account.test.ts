import { expect, mock, test } from 'claude-code/testing'
import { type Account, type AccountView, accountOf, type Figures, nextView } from '../hooks/account'

// The facts line names the account the session runs on: the plan name from the login record, unconfirmed after a
// /login until the session's own plan figures move, then one note that the switch took.

const NOON_UTC = Date.UTC(2026, 9, 2, 16, 0, 0)
const CONFIG = 'C:/Users/me/.claude.json'
const ULTRA = [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-02T19:00:00Z' }]
const MAX = [{ kind: 'five_hour', percentUsed: 4, resetsAt: '2026-10-02T21:00:00Z' }]

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

const A = { id: 'acct-a', label: 'Ultra' }
const B = { id: 'acct-b', label: 'Max' }
const EARLY = Date.UTC(2026, 9, 2, 17, 0, 0)
const LATE = Date.UTC(2026, 9, 2, 20, 0, 0)
const ON_A = { five_hour: '2026-10-02T19:00:00Z' }
const ON_B = { five_hour: '2026-10-02T21:00:00Z' }
const ROLLED_A = { five_hour: '2026-10-03T00:00:00Z' }
const PENDING_B = { onRecord: B, confirmed: A, figuresAtSwitch: ON_A }
type Row = [string, AccountView | undefined, Account | undefined, Figures | undefined, number, string, boolean]
const VIEWS: Row[] = [
  ['the first account seen is the one the session runs on', undefined, A, ON_A, EARLY, 'Ultra', false],
  ['another account on record waits for proof', { onRecord: A, confirmed: A }, B, ON_A, EARLY, 'Max?', false],
  ['figures moved before the old reset prove it', PENDING_B, B, ON_B, EARLY, 'Max', true],
  ['the confirmed account back on record is no switch', PENDING_B, A, ON_A, EARLY, 'Ultra', false],
  ['the old window rolling over proves nothing', PENDING_B, B, ROLLED_A, LATE, 'Max?', false],
  ['a window kind that appears proves nothing', PENDING_B, B, { ...ON_A, seven_day: 'x' }, EARLY, 'Max?', false],
  ['no figures at the switch: the first ones are only a baseline', { onRecord: B, confirmed: A }, B, ON_B, EARLY,
    'Max?', false],
  ['a missing record changes nothing', PENDING_B, undefined, ON_B, EARLY, 'Max?', false],
]
for (const [name, view, account, figures, now, shown, isSwitched] of VIEWS) {
  test(`account view: ${name}`, () => {
    const next = nextView(view, account, figures, now)
    const v = next.view
    const label = v && `${v.onRecord.label}${v.onRecord.id === v.confirmed.id ? '' : '?'}`
    expect([label, next.isSwitched]).toEqual([shown, isSwitched])
  })
}

test('a /login shows as unconfirmed until the plan figures move, then as switched once', async ($, on) => {
  mock.clock(on, { now: NOON_UTC })
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  on('process.run', () => {
    throw new Error('no node')
  })
  let limits = ULTRA
  const context = { tokens: 1_000, window: 1_000_000 }
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits: limits } }))
  const files = new Map<string, string>()
  const signIn = (id: string, plan: string) =>
    files.set(CONFIG, JSON.stringify({ oauthAccount: { accountUuid: id, planDisplayName: plan } }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path.replaceAll('\\', '/'))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } as never }))
  let line = ''
  on('prompt.submit', ($, e) => {
    line = e.context?.[0] ?? ''
    return { text: e.text, context: e.context }
  })
  const prompt = () => $.prompt.submit({ text: 'next' } as never)

  signIn('acct-ultra', 'Ultra')
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await prompt()
  expect(line).toContain(' | account Ultra')
  expect(line).not.toContain('not confirmed')

  signIn('acct-max', 'Max')
  await prompt()
  expect(line).toContain(' | account Max, not confirmed yet')

  limits = MAX
  await prompt()
  expect(line).toContain(' | account Max | switched to Max')

  await prompt()
  expect(line).toContain(' | account Max')
  expect(line).not.toContain('switched')
  expect(line).not.toContain('not confirmed')

  files.delete(CONFIG)
  await prompt()
  expect(line).toContain(' | account Max')
})

import { expect, mock, test } from 'claude-code/testing'
import { accountOf } from '../hooks/account'

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

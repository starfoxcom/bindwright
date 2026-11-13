import { expect, test } from 'claude-code/testing'

import { wakeText } from '../hooks/register'
import {
  isResearchDue, type Lookup, type PrRounds, recordRound, redStreak, roundsToResearch, sourcesOwed,
} from '../hooks/rounds'
import type { Watch } from '../types'
import { type Seen, world } from './world'

const RED = 'FAILURE'
const reds = (n: number) => Array.from({ length: n }, () => RED)
const path = 'C:/Users/me/.claude/mods-data/ci-watch/rounds.json'
// Dozens of fake-clock polls: a slow runner can take past the default 5 s.
const LONG = { timeoutMs: 15_000 }

// The rounds ci-watch saw settle on the PR, oldest first: any result but SUCCESS had a failed check.
function seed(seen: Seen, results: string[]) {
  seen.isReadable = true
  const rounds = results.map((result, i) => ({ sha: `c${i}`, red: result !== 'SUCCESS' }))
  seen.files.set(path, JSON.stringify({ 'o/r#7': { rounds } }))
}

// Newest first, back to the last round that passed.
test('red rounds count back to a green round', () => {
  const of = (results: boolean[]) =>
    results.reduce<PrRounds>((pr, red, i) => recordRound(pr, `c${i}`, red), { rounds: [] })
  expect(redStreak(undefined)).toBe(0)
  expect(redStreak(of([true, true, true, true, true, true]))).toBe(6)
  expect(redStreak(of([true, true, true, false, true, true]))).toBe(2)
  expect(redStreak(of([true, false]))).toBe(0)
  expect(redStreak({ rounds: [] })).toBe(0)
})

// A re-run of a head already counted replaces its round; the list keeps the newest fifty.
test('a re-run replaces its round, and the list stays bounded', () => {
  const twice = recordRound(recordRound({ rounds: [] }, 'a', true), 'a', false)
  expect(twice).toEqual({ rounds: [{ sha: 'a', red: false }] })
  let many = { rounds: [] as { sha: string; red: boolean }[] }
  for (let i = 0; i < 80; i++) many = recordRound(many, `c${i}`, true)
  expect(many.rounds).toHaveLength(50)
  expect(redStreak(many)).toBe(50)
  expect(redStreak({ rounds: 'x' } as never)).toBe(0)
})

// Each step back that leaves the PR red leaves one round fewer before the next: 3, then 2, then 1.
test('the research step is due at 3, 5 and every red round from 6', () => {
  const due = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(isResearchDue)
  expect(due).toEqual([3, 5, 6, 7, 8, 9])
  expect([0, 2, 3, 4, 5, 6, 9].map(roundsToResearch)).toEqual([3, 1, 2, 1, 1, 1, 1])
})

const failed = (outcome: Watch['outcome']): Watch =>
  ({ repo: 'o/r', number: 7, headSha: 'a1', startedAt: 0, checks: { build: 'fail' }, stablePolls: 2, outcome }) as Watch

test('only a red wake at a due count carries the research step', () => {
  expect(wakeText(failed('failed'), undefined, 3)).toContain('look up at least three different ways the community')
  expect(wakeText(failed('failed'), undefined, 3)).toContain('o/r#7 has had 3 fix rounds in a row')
  expect(wakeText(failed('failed'), undefined, 6)).toContain('has had 6 fix rounds')
  expect(wakeText(failed('failed'), undefined, 5)).toContain('has had 5 fix rounds')
  for (const red of [0, 2, 4]) expect(wakeText(failed('failed'), undefined, red)).not.toContain('research')
  expect(wakeText(failed('passed'), undefined, 3)).not.toContain('research')
  expect(wakeText(failed('timeout'), undefined, 3)).not.toContain('research')
})

// The step back as a table: due counts only, and three distinct topics looked up after the last red round
// settled. A round saved without its time counts as settled at 0.
test('a step back owes three distinct lookups made after the last red round settled', () => {
  const settledAt = (n: number, at?: number): PrRounds => ({
    rounds: Array.from({ length: n }, (_, i) => ({ sha: `c${i}`, red: true, ...(at === undefined ? {} : { at }) })),
  })
  const look = (...entries: [number, string][]) => entries.map(([at, topic]) => ({ at, topic }))
  const rows: [string, PrRounds, Lookup[], number][] = [
    ['not due at 4', settledAt(4, 100), [], 0],
    ['due at 3, nothing looked up', settledAt(3, 100), [], 3],
    ['lookups before the round', settledAt(6, 100), look([50, 'a'], [60, 'b'], [70, 'c']), 3],
    ['a lookup at the same moment', settledAt(6, 100), look([100, 'a']), 3],
    ['one lookup after', settledAt(6, 100), look([101, 'a']), 2],
    ['the same topic twice', settledAt(6, 100), look([101, 'a'], [102, 'a']), 2],
    ['three distinct after', settledAt(6, 100), look([101, 'a'], [102, 'b'], [103, 'c']), 0],
    ['a round without its time', settledAt(5), look([1, 'a']), 2],
  ]
  for (const [name, pr, lookups, owed] of rows) expect([name, sourcesOwed(pr, lookups)]).toEqual([name, owed])
})

// While a watched PR owes its step back, the session's edits, commits and pushes wait; nothing else does.
test('at a step back, edits, commits and pushes wait for three distinct lookups', async ($, on) => {
  const { seen } = world(on)
  const tools = ['Edit', 'Write', 'WebSearch', 'WebFetch', 'Agent'] as const
  on('tool.call', { tool: tools }, async ($, e) =>
    (e as { url?: string }).url === 'https://down.example' ? { result: 'down', isError: true } : { result: 'done' })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const call = (input: Record<string, unknown>) => $.tool.call(input as never)
  const bash = (command: string) => call({ tool: 'Bash', command })
  seed(seen, reds(4))
  expect(await bash('git push origin feature/x')).not.toHaveProperty('deny')
  seed(seen, reds(6))
  const held = [
    () => bash('git push origin feature/x'),
    () => call({ tool: 'PowerShell', command: 'git push' }),
    () => bash('git -C . commit -m "fix it"'),
    () => call({ tool: 'Edit', file_path: 'C:/repo/a.ts', old_string: 'a', new_string: 'b' }),
    () => call({ tool: 'Write', file_path: 'C:/repo/a.ts', content: 'b' }),
  ]
  for (const attempt of held) expect(await attempt()).toHaveProperty('deny')
  expect(String(((await bash('git push')) as { deny?: string }).deny)).toContain('3 more to go')
  for (const command of ['git log --grep push', 'git stash push', 'echo "then git push"']) {
    expect(await bash(command)).not.toHaveProperty('deny')
  }
  expect(await call({ tool: 'Bash', command: 'git push', agentId: 'helper' })).not.toHaveProperty('deny')
  await call({ tool: 'WebSearch', query: 'how others solve it' })
  await call({ tool: 'WebSearch', query: ' How others solve it' })
  await call({ tool: 'WebFetch', url: 'https://down.example' })
  await call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'look around' })
  expect(String(((await bash('git push')) as { deny?: string }).deny)).toContain('2 more to go')
  await call({ tool: 'Agent', subagent_type: 'web-fetch', prompt: 'read https://example.com/b' })
  await call({ tool: 'WebFetch', url: 'https://example.com/c' })
  const edit = { tool: 'Edit', file_path: 'C:/repo/a.ts', old_string: 'a', new_string: 'b' }
  expect(await call(edit)).not.toHaveProperty('deny')
  expect(await bash('git push origin feature/x')).not.toHaveProperty('deny')
})

// The third red round in a row: its own settled watch makes the count three, and the wake asks for research.
test('the wake of the third red round in a row asks for the research step', async ($, on) => {
  const { seen, clock } = world(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seed(seen, reds(2))
  seen.bucket = 'fail'
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let i = 0; i < 6; i++) await clock.advance(30_000)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('all checks settled; failed')
  expect(seen.prompts[0]).toContain('has had 3 fix rounds in a row')
})

test('/ci-watch rounds tells the count and when the next step back is due', async ($, on) => {
  const { seen } = world(on)
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seed(seen, reds(7))
  const ask = async (args: string) =>
    ((await $.command.run({ command: 'ci-watch', args, origin: { kind: 'composer' } } as never)) as { text: string })
      .text
  expect(await ask('rounds')).toBe(
    'o/r#7: 7 fix round(s) in a row without every check green; the next step back is due in 1.',
  )
  expect(await ask('rounds 7')).toContain('o/r#7: 7 fix round(s) in a row')
  expect(await ask('rounds reset 7')).toContain('/ci-watch rounds')
  expect(JSON.parse(seen.files.get(path) ?? '{}')['o/r#7'].rounds).toHaveLength(7)
})

// A watch that settles is a round: the session's own pushes fill the count, with no history read.
test('each settled watch of a pushed head adds a round; an unreadable count file reads as none', async ($, on) => {
  const { seen, clock } = world(on)
  seen.isReadable = true
  seen.files.set(path, 'not json')
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seen.bucket = 'fail'
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let i = 0; i < 6; i++) await clock.advance(30_000)
  const round = JSON.parse(seen.files.get(path) ?? '{}')['o/r#7']
  expect(round).toMatchObject({ rounds: [{ sha: 'a1', red: true }] })
  // Stamped when it settled, after the push at 1000: the time a step back's lookups must come after.
  expect(typeof round.rounds[0].at === 'number' && round.rounds[0].at > 1_000).toBe(true)
})

// A head someone else pushed (a silent watch, past the hour after this session's push) is no round of this
// session's: its red run never counts.
test("a silent watch of someone else's head adds no round", LONG, async ($, on) => {
  const { seen, clock } = world(on)
  seen.isReadable = true
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seen.bucket = 'pass'
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let i = 0; i < 3; i++) await clock.advance(30_000)
  await clock.advance(2 * 60 * 60_000)
  seen.head = 'b2'
  seen.bucket = 'fail'
  for (let i = 0; i < 25; i++) await clock.advance(30_000)
  const rounds = (JSON.parse(seen.files.get(path) ?? '{}') as Record<string, PrRounds>)['o/r#7']?.rounds
  expect(rounds).toMatchObject([{ sha: 'a1', red: false }])
})

// A round another session writes while this one is being added is the state it adds to: the file is read
// once, right before the write, with nothing in between that could let that round land unseen.
test("a round adds to the count file as read right before its write", async ($, on) => {
  const { seen, clock } = world(on)
  seen.isReadable = true
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seen.bucket = 'fail'
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  seed(seen, reds(5))
  seen.order = []
  for (let i = 0; i < 6; i++) await clock.advance(30_000)
  // The wake then reads the count once more, for its research step.
  const steps = seen.order.filter(step => step.endsWith('/rounds.json'))
  expect(steps).toEqual([`read ${path}`, `write ${path}`, `read ${path}`])
  expect(redStreak(JSON.parse(seen.files.get(path) ?? '{}')['o/r#7'])).toBe(6)
})

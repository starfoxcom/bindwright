import { type Engine, expect, test } from 'claude-code/testing'

import { followId, type Memory } from '../hooks/owner'
import { wakeText } from '../hooks/register'
import { isResearchDue, type PrRounds, recordRound, redStreak, roundsToResearch, withTopic } from '../hooks/rounds'
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

// A latched step back counts distinct topics and ends at the third.
test('a step back counts each topic once and ends at three', () => {
  expect(withTopic([], ' How Others Solve It ')).toEqual(['how others solve it'])
  expect(withTopic(['a'], 'A')).toEqual(['a'])
  expect(withTopic(['a'], '  ')).toEqual(['a'])
  expect(withTopic(['a', 'b'], 'c')).toBeUndefined()
})

type World = ReturnType<typeof world>
const editInput = { tool: 'Edit', file_path: 'C:/repo/a.ts', old_string: 'a', new_string: 'b' }

// The PR's red rounds in a row before this push, then the push's own round settles red.
async function redRound($: Engine, { seen, clock }: World, before: number) {
  seed(seen, reds(before))
  seen.bucket = 'fail'
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let i = 0; i < 6; i++) await clock.advance(30_000)
}

// The red wake that asks for a step back latches it: edits, commits and pushes wait for three distinct
// lookups, and nothing else does.
test('a step back holds edits, commits and pushes until three distinct lookups ran', async ($, on) => {
  const w = world(on)
  const tools = ['Edit', 'Write', 'WebSearch', 'WebFetch', 'Agent'] as const
  on('tool.call', { tool: tools }, async ($, e) =>
    (e as { url?: string }).url === 'https://down.example' ? { result: 'down', isError: true } : { result: 'done' })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const call = (input: Record<string, unknown>) => $.tool.call(input as never)
  const bash = (command: string) => call({ tool: 'Bash', command })
  await redRound($, w, 5)
  const held = [
    () => bash('git push origin feature/x'),
    () => call({ tool: 'PowerShell', command: 'git push' }),
    () => bash('git -C . commit -m "fix it"'),
    () => bash('git commit>commit.log -m "fix it"'),
    () => call(editInput),
    () => call({ tool: 'Write', file_path: 'C:/repo/a.ts', content: 'b' }),
  ]
  for (const attempt of held) expect(await attempt()).toHaveProperty('deny')
  expect(String(((await bash('git push')) as { deny?: string }).deny)).toContain('3 more to go')
  const notHeld = ['git log --grep push', 'git stash push', 'echo "then git push"', 'git commit-graph write',
    'git -c commit.gpgsign=false rebase --continue', 'git -c push.default=current status']
  for (const command of notHeld) {
    expect(await bash(command)).not.toHaveProperty('deny')
  }
  expect(await call({ tool: 'Bash', command: 'git push', agentId: 'helper' })).not.toHaveProperty('deny')
  await call({ tool: 'WebSearch', query: 'how others solve it' })
  await call({ tool: 'WebSearch', query: ' How others solve it' })
  await call({ tool: 'WebFetch', url: 'https://down.example' })
  await call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'look around' })
  // A subagent's own lookups (the pages a web-fetch agent reads) are not the main session's.
  await call({ tool: 'WebFetch', url: 'https://example.com/inner', agentId: 'fetcher' })
  await call({ tool: 'WebSearch', query: 'inner search', agentId: 'fetcher' })
  expect(String(((await bash('git push')) as { deny?: string }).deny)).toContain('2 more to go')
  // Lookups sent together all count.
  await Promise.all([
    call({ tool: 'Agent', subagent_type: 'web-fetch', prompt: 'read https://example.com/b' }),
    call({ tool: 'WebFetch', url: 'https://example.com/c' }),
  ])
  expect(await call(editInput)).not.toHaveProperty('deny')
  expect(await bash('git push origin feature/x')).not.toHaveProperty('deny')
})

// A red wake at a count that is not due latches nothing; a new watch of the PR keeps a latched step back,
// and only a green round or the user's /ci-watch stop lifts it without lookups.
test('only a due red wake latches a step back, and only lookups, green or a stop lift it', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Edit' }, async () => ({ result: 'done' }))
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const edit = () => $.tool.call(editInput as never)
  await redRound($, w, 3)
  expect(await edit()).not.toHaveProperty('deny')
  w.seen.head = 'b2'
  await redRound($, w, 5)
  expect(await edit()).toHaveProperty('deny')
  // A head pushed from elsewhere restarts the settled watch on the next poll, and the step back stays.
  w.seen.head = 'c3'
  w.seen.bucket = 'pending'
  for (let i = 0; i < 6; i++) await w.clock.advance(30_000)
  expect(await edit()).toHaveProperty('deny')
  await $.tool.call({ tool: 'mcp__ci-watch__watch', pr: 7, repo: 'o/r' } as never)
  expect(await edit()).toHaveProperty('deny')
  // A green round on the PR ends it: the problem it asked about is fixed.
  w.seen.bucket = 'pass'
  for (let i = 0; i < 6; i++) await w.clock.advance(30_000)
  expect(await edit()).not.toHaveProperty('deny')
  w.seen.head = 'd4'
  await redRound($, w, 5)
  expect(await edit()).toHaveProperty('deny')
  await $.command.run({ command: 'ci-watch', args: 'stop', origin: { kind: 'composer' } } as never)
  expect(await edit()).not.toHaveProperty('deny')
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  expect(await edit()).not.toHaveProperty('deny')
})

// A resume joins the saved copy of a watch that settled meanwhile: a step back latched in memory stays
// unless that copy went green.
test('a resume keeps a latched step back unless the saved copy went green', async () => {
  const base: Watch = { repo: 'o/r', number: 7, headSha: 'a1', startedAt: 0, checks: {}, stablePolls: 0 }
  const rows: [Watch['outcome'], string[] | undefined][] = [['failed', ['a']], ['passed', undefined]]
  for (const [outcome, kept] of rows) {
    // The engine as followId uses it: the resumed id, and that id's saved state.
    const saved = JSON.stringify({ watches: [{ ...base, outcome }] })
    const engine = { session: { id: async () => 's2' }, fs: { read: async () => saved } }
    const watches = [{ ...base, stepBackTopics: ['a'] }]
    const memory: Memory = { watches, stateId: 's1', isUnsaved: false, generation: 0 }
    await followId(engine as never, 'C:/data', memory)
    expect([outcome, memory.watches[0]?.stepBackTopics]).toEqual([outcome, kept])
  }
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
  expect(JSON.parse(seen.files.get(path) ?? '{}')['o/r#7']).toEqual({ rounds: [{ sha: 'a1', red: true }] })
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
  expect(rounds).toEqual([{ sha: 'a1', red: false }])
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

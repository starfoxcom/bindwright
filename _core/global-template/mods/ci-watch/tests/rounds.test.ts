import { type Engine, expect, test } from 'claude-code/testing'

import { followId, type Memory } from '../hooks/owner'
import { wakeText } from '../hooks/register'
import {
  crossedResearch, isResearchDue, type PrRounds, recordRound, redStreak, roundsToResearch, withTopic,
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

const of = (results: boolean[]) =>
  results.reduce<PrRounds>((pr, red, i) => recordRound(pr, `c${i}`, red), { rounds: [] })

// A round is green only when the PR merges at its head: one that passed and was followed by another push counts red.
test('a round that passed but did not merge counts red once another head follows', () => {
  expect(redStreak(undefined)).toBe(0)
  expect(redStreak(of([true, true, true, true, true, true]))).toBe(6)
  expect(redStreak(of([true, true, true, false, true, true]))).toBe(6)
  expect(redStreak(of([true, false]))).toBe(0)
  expect(redStreak({ rounds: [] })).toBe(0)
})

// Red, red, passed, red: the streak jumps from 0 to 4 and steps over the 3rd, which still owes its step back.
test('a streak that jumps past a research step still asks for it', () => {
  const step = (results: boolean[]) => crossedResearch(of(results.slice(0, -1)), of(results))
  expect(step([true, true, false, true])).toBe(true)
  expect(step([true, true, true])).toBe(true)
  expect(step([true, true, true, true])).toBe(false)
  expect(step([true, true])).toBe(false)
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
  expect(wakeText(failed('failed'), undefined, 3)).toContain('look up at least five different ways the community')
  expect(wakeText(failed('failed'), undefined, 3)).toContain('o/r#7 has had 3 fix rounds in a row')
  expect(wakeText(failed('failed'), undefined, 6)).toContain('has had 6 fix rounds')
  expect(wakeText(failed('failed'), undefined, 5)).toContain('has had 5 fix rounds')
  for (const red of [0, 2, 4]) expect(wakeText(failed('failed'), undefined, red)).not.toContain('research')
  expect(wakeText(failed('passed'), undefined, 3)).not.toContain('research')
  expect(wakeText(failed('timeout'), undefined, 3)).not.toContain('research')
})

// The 10th red round in a row is the hard stop: the wake asks to close the PR and rebuild it.
test('the wake from the 10th red round on asks to close and rebuild the PR', () => {
  for (const red of [10, 12]) expect(wakeText(failed('failed'), undefined, red)).toContain('That is the hard stop')
  expect(wakeText(failed('failed'), undefined, 9)).not.toContain('hard stop')
  expect(wakeText(failed('failed'), undefined, 9)).toContain('The next step back comes after 1 more')
})

// At the hard stop commits and pushes wait until the PR is closed; edits do not, and closing it lifts it.
test('the hard stop holds commits and pushes until the PR is closed', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: ['Edit', 'WebSearch'] }, async () => ({ result: 'done' }))
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as never)
  await redRound($, w, 9)
  for (const query of ['a', 'b', 'c', 'd', 'e']) await $.tool.call({ tool: 'WebSearch', query } as never)
  expect(await $.tool.call(editInput as never)).not.toHaveProperty('deny')
  expect(String(((await bash('git commit -m "fix"')) as { deny?: string }).deny)).toContain('the hard stop')
  expect(await bash('git push')).toHaveProperty('deny')
  w.seen.prState = 'CLOSED'
  expect(await bash('git commit -m "rebuild"')).not.toHaveProperty('deny')
})

// A latched step back counts distinct topics and ends at the fifth, at every red round that asks for one.
test('a step back counts each topic once and ends at five', () => {
  expect(withTopic([], ' How Others Solve It ')).toEqual(['how others solve it'])
  expect(withTopic(['a'], 'A')).toEqual(['a'])
  expect(withTopic(['a'], '  ')).toEqual(['a'])
  expect(withTopic(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  expect(withTopic(['a', 'b', 'c', 'd'], 'e')).toBeUndefined()
  for (const red of [3, 8]) {
    expect(wakeText(failed('failed'), undefined, red)).toContain('look up at least five different ways')
  }
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

// The red wake that asks for a step back latches it: edits, commits and pushes wait for five distinct
// lookups, and nothing else does.
test('a step back holds edits, commits and pushes until five distinct lookups ran', async ($, on) => {
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
  expect(String(((await bash('git push')) as { deny?: string }).deny)).toContain('5 more to go')
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
  expect(String(((await bash('git push')) as { deny?: string }).deny)).toContain('4 more to go')
  // Lookups sent together all count.
  await Promise.all([
    call({ tool: 'Agent', subagent_type: 'web-fetch', prompt: 'read https://example.com/b' }),
    call({ tool: 'WebFetch', url: 'https://example.com/c' }),
    call({ tool: 'WebSearch', query: 'a third way' }),
  ])
  expect(String(((await bash('git push')) as { deny?: string }).deny)).toContain('1 more to go')
  await call({ tool: 'WebSearch', query: 'a fourth way' })
  expect(await call(editInput)).not.toHaveProperty('deny')
  expect(await bash('git push origin feature/x')).not.toHaveProperty('deny')
})

// The bar is fixed when the step back latches, so a count file another session is rewriting meanwhile
// cannot lower it.
test('a latched step back holds until five lookups ran, whatever the count file says', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: ['Edit', 'WebSearch'] }, async () => ({ result: 'done' }))
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await redRound($, w, 7)
  w.seen.files.set(path, 'not json')
  for (const query of ['a', 'b', 'c']) await $.tool.call({ tool: 'WebSearch', query } as never)
  const held = String(((await $.tool.call(editInput as never)) as { deny?: string }).deny)
  expect(held).toContain('at least 5 different ways')
  expect(held).toContain('2 more to go')
  for (const query of ['d', 'e']) await $.tool.call({ tool: 'WebSearch', query } as never)
  expect(await $.tool.call(editInput as never)).not.toHaveProperty('deny')
})

// The step back is about the red PR, so work on another branch goes on; an unreadable branch still waits.
test("a step back holds only work on the red PR's branch", async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: ['Edit', 'Write'] }, async () => ({ result: 'done' }))
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const call = (input: Record<string, unknown>) => $.tool.call(input as never)
  const bash = (command: string) => call({ tool: 'Bash', command })
  await redRound($, w, 5)
  // The shell sits on another PR's branch; the red PR's branch is checked out in C:/repo.
  w.seen.checkedOut = { 'C:/session': 'feature/y', 'C:/other': 'feature/y', 'C:/repo': 'feature/x' }
  w.seen.checkedOut['C:\\other'] = 'feature/y'
  // Neither the shell's folder nor C:/other holds any of the red PR's commits, on any local branch.
  w.seen.history = { 'C:/session': [], 'C:/other': [], 'C:\\other': [] }
  w.seen.redRefs = { 'C:/session': '' }
  const passes = [
    'git commit -m "fix the other PR"', 'git commit -m b && git push',
    'git commit -m "fix #12, don\'t hold" ; git push -u origin feature/y',
  ]
  const refusal = expect.objectContaining({ deny: expect.any(String) })
  const denied = (command: string) => expect.arrayContaining([command, refusal])
  for (const command of passes) expect([command, await bash(command)]).not.toEqual(denied(command))
  expect(await call({ ...editInput, file_path: 'C:/other/b.ts' })).not.toHaveProperty('deny')
  expect(await call({ ...editInput, file_path: 'C:\\other\\b.ts' })).not.toHaveProperty('deny')
  expect(await call(editInput)).toHaveProperty('deny')
  expect(await call({ ...editInput, file_path: 'C:\\repo\\a.ts' })).toHaveProperty('deny')
  // The PowerShell tool keeps its own folder, so its commits wait.
  expect(await call({ tool: 'PowerShell', command: 'git commit -m x' })).toHaveProperty('deny')
  // Every shape whose branch the reader cannot see in full waits.
  const waits = [
    'git push origin feature/x', 'git -C C:/repo commit -m "fix it"', '  cd C:/repo && git commit -m x',
    'git -C C:/other commit -m "b"; cd C:/repo && git push', '(cd C:/repo && git commit -m x)',
    '{ cd C:/repo; git commit -m x; }', 'if true; then cd C:/repo; git commit -m x; fi',
    'git -c user.name=a -C C:/repo commit -m x', 'GIT_DIR=C:/repo/.git git commit -m x',
    'env -C C:/repo git commit -m x', 'gh pr checkout 7 && git commit -am fix', 'git switch - && git commit -am fix',
    'git commit -m "$(git switch feature/x)"', 'git commit -m x | tee log',
    // Quotes and comments the shell reads differently from a pattern, and a path glued to a quote.
    "git commit -m a\\'b ; cd C:/repo ; git commit -m c\\'d", 'git commit -m a\\"b ; cd C:/repo ; git commit -m "c"',
    "git commit -m x # don't\ncd C:/repo; git commit -m y # isn't",
    "git commit -m 'msg\nsee <<EOF'\ncd C:/repo\ngit commit -m y",
    'cd "C:/other"/../repo && git commit -m x', 'cd C:/other && git -C ../repo commit -m x',
    // A folder move or a carriage return, which leave the shell where its text does not say.
    'cd C:/other && git commit -m b && git push', 'git -C C:/other commit -m b', 'git commit -m x\r\ngit push',
    // Pushes that may send the red branch without naming it plainly.
    'git push origin HEAD:feat"ure"/x', 'git push --all', 'git push origin :',
    "git push origin 'refs/heads/*:refs/heads/*'",
  ]
  for (const command of waits) expect([command, await bash(command)]).toEqual(denied(command))
  // Only a config that sends each pushed name to itself lifts a push; a valueless key counts as set.
  w.seen.gitConfig = { 'C:/session': 'push.default\nsimple\0remote.origin.url\nu\0' }
  expect(await bash('git push')).not.toHaveProperty('deny')
  // Output cut at the engine's limit may hide a key past the cut, so it is no answer.
  w.seen.isGitCut = true
  expect(await bash('git push')).toHaveProperty('deny')
  w.seen.isGitCut = false
  const configs = [
    'remote.origin.mirror\ntrue\0', 'remote.origin.mirror\0', 'push.default\nupstream\0',
    'push.recursesubmodules\non-demand\0', 'submodule.recurse\ntrue\0',
  ]
  for (const config of configs) {
    w.seen.gitConfig = { 'C:/session': config }
    expect([config, await bash('git push origin try-fix')]).toEqual(denied(config))
  }
  // A file at a drive root is in that root, not in the drive's current folder.
  w.seen.checkedOut['C:'] = 'feature/y'
  w.seen.history['C:'] = []
  expect(await call({ ...editInput, file_path: 'C:\\a.ts' })).toHaveProperty('deny')
  // A shell moved to the red branch's folder.
  w.seen.cwd = 'C:/repo'
  expect(await bash('git commit -m x')).toHaveProperty('deny')
  w.seen.cwd = undefined
  // Refs ignore case on Windows and macOS, so a branch that differs only in case is the red PR's.
  w.seen.checkedOut['C:/session'] = 'Feature/X'
  expect(await bash('git commit -m x')).toHaveProperty('deny')
  // A push of a local branch that holds the red PR's work, whatever the branch it sits on.
  w.seen.checkedOut['C:/session'] = 'feature/y'
  w.seen.redRefs['C:/session'] = 'refs/heads/try-fix'
  expect(await bash('git push origin try-fix')).toHaveProperty('deny')
  // Work under another name, a fork's checkout or a renamed branch, whose history holds the PR's commits.
  w.seen.checkedOut['C:/session'] = 'alice/main'
  w.seen.history['C:/session'] = ['c0ffee0']
  expect(await bash('git commit -m x')).toHaveProperty('deny')
  // After a rewrite (amend, rebase, force-push) the PR's commits are new, and work holding them waits.
  w.seen.prCommits = ['d00d000']
  w.seen.history['C:/session'] = ['d00d000']
  expect(await bash('git commit -m x')).toHaveProperty('deny')
  // Work holding none of the PR's current commits goes on.
  w.seen.history['C:/session'] = []
  expect(await bash('git commit -m x')).not.toHaveProperty('deny')
  // A shallow clone's commit test may answer a false no, so it is no answer.
  w.seen.shallow = ['C:/session']
  expect(await bash('git commit -m x')).toHaveProperty('deny')
  w.seen.shallow = []
  // A list as long as `gh` lists may be cut, so the PR's commits count as unread.
  w.seen.prCommits = Array.from({ length: 100 }, (_, i) => `abc${String(i).padStart(4, '0')}`)
  expect(await bash('git commit -m x')).toHaveProperty('deny')
  w.seen.isGitDown = true
  expect(await bash('git commit -m "fix the other PR"')).toHaveProperty('deny')
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
  seed(seen, reds(10))
  expect(await ask('rounds')).toContain('that is the hard stop')
  seed(seen, reds(7))
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

// Which red settles count as a fix round: each row is one case, and this table is the rule. A settle keeps
// the count only when a review run never got to post its review; every other red settle counts.
const ROUTINE = '## Code Review\n<!-- review-run: 11-1 review -->\n\n🟢 LGTM\n'
const REQUEST = '@claude review this PR — depth pass.\n\n<!-- review-run: 11-1 request -->\n'
const DEEP = '## Deep review\n<!-- deep-run: 12-1 review -->\n\n- a finding\n\n**Verdict:** 🔴 Blocking\n'
// The review workflow's early jobs, which a cancel during triage leaves cancelled.
const EARLY = ['Diff triage', 'Project triggers', 'Project pre-screen']
type VerdictRow = {
  name: string
  state?: string
  comments?: { at?: string; body: string }[]
  deepWorkflow?: string
  build: string
  // Review workflow jobs a cancel left in the cancelled bucket, beside the failed gate.
  cancelled?: string[]
  counted: boolean
}
const VERDICT_ROWS: VerdictRow[] = [
  {
    name: 'a deep run that errored after the routine 🟢',
    state: 'routine=pass;escalated=yes;deep=error',
    comments: [{ body: ROUTINE }],
    build: 'pass',
    counted: false,
  },
  {
    name: 'a review that errored before its post',
    state: 'routine=error;deep=none',
    comments: [{ body: REQUEST }],
    build: 'pass',
    counted: false,
  },
  {
    name: 'an errored review with a review from an earlier head',
    state: 'routine=error',
    comments: [{ body: ROUTINE, at: '1969-12-31T23:59:00Z' }],
    build: 'pass',
    counted: false,
  },
  {
    name: 'a deep run whose review the gate did not find, with none posted',
    state: 'routine=pass;escalated=yes;deep=missing',
    comments: [{ body: ROUTINE }],
    build: 'pass',
    counted: false,
  },
  {
    name: 'a deep 🔴 the gate did not find',
    state: 'routine=pass;escalated=yes;deep=missing',
    comments: [{ body: ROUTINE }, { body: DEEP }],
    build: 'pass',
    counted: true,
  },
  { name: 'a cancelled review run', state: 'triage=reviewable;routine=pending', build: 'pass', counted: false },
  { name: "a routine 🔴", state: 'routine=block;deep=none', build: 'pass', counted: true },
  { name: 'a routine 🔴 then an errored deep run', state: 'routine=block;deep=error', build: 'pass', counted: true },
  { name: "a deep 🔴", state: 'routine=pass;escalated=yes;deep=block', build: 'pass', counted: true },
  { name: 'a gate state with no tier', state: '', build: 'pass', counted: true },
  { name: 'a run cancelled in triage', state: 'routine=error', build: 'pass', cancelled: EARLY, counted: false },
  {
    name: 'a run cancelled after its review posted',
    state: 'routine=error',
    comments: [{ body: ROUTINE }],
    build: 'pass',
    cancelled: EARLY,
    counted: true,
  },
  { name: 'a failed gate whose tiers all passed', state: 'routine=pass;deep=none', build: 'pass', counted: true },
  { name: 'a gate state that cannot be read', build: 'pass', counted: true },
  { name: 'a failed test beside an errored review', state: 'routine=error;deep=none', build: 'fail', counted: true },
  {
    name: 'a routine review posted before its job failed',
    state: 'routine=error',
    comments: [{ body: ROUTINE }],
    build: 'pass',
    counted: true,
  },
  {
    name: 'a deep review posted before its read failed',
    state: 'routine=pass;escalated=yes;deep=error',
    comments: [{ body: ROUTINE }, { body: DEEP }],
    build: 'pass',
    counted: true,
  },
  {
    name: 'an errored deep run on a workflow that marks no reviews',
    state: 'routine=pass;escalated=yes;deep=error',
    deepWorkflow: 'jobs: {}\n',
    build: 'pass',
    counted: true,
  },
]
for (const row of VERDICT_ROWS) {
  test(`a red settle from ${row.name} ${row.counted ? 'counts' : 'keeps the count'}`, async ($, on) => {
    const { seen, clock } = world(on)
    await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
    seed(seen, reds(2))
    seen.bucket = row.build
    const early = (row.cancelled ?? []).map(name => ({ name, bucket: 'cancel' }))
    seen.rows = [{ name: 'Review gate', bucket: 'fail' }, { name: 'Claude On-Demand', bucket: 'fail' }, ...early]
    seen.gateState = row.state
    seen.comments = row.comments
    seen.deepWorkflow = row.deepWorkflow
    await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
    for (let i = 0; i < 6; i++) await clock.advance(30_000)
    expect(redStreak(JSON.parse(seen.files.get(path) ?? '{}')['o/r#7'])).toBe(row.counted ? 3 : 2)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]?.includes('has had 3 fix rounds in a row')).toBe(row.counted)
    expect(seen.prompts[0]?.includes('the count stays at 2')).toBe(!row.counted)
  })
}

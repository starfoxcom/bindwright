import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { notifiedIds, QUIET_MS, startedRun } from '../hooks/runs'
import { world } from './world'

const MINUTE = 60_000
const FILE = 'C:/Temp/tasks/b1.output'
// What the engine answers for a background shell: its record, and the text the model reads.
const SHELL_RECORD = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }
const SHELL_TEXT =
  `Command running in background with ID: b1. Output is being written to: ${FILE}. ` +
  'You will be notified when it completes.'
const AGENT_RECORD = {
  status: 'async_launched',
  agentId: 'a1b2',
  description: 'review',
  prompt: 'review it',
  outputFile: 'C:/Temp/tasks/a1b2.output',
}
const ENDED = '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>'

test('a background start is read from the record the tool answers, and nothing else is one', () => {
  const cases: [string, unknown, string, unknown][] = [
    ['a background shell', SHELL_RECORD, SHELL_TEXT, { id: 'b1', file: FILE }],
    ['an async agent', AGENT_RECORD, 'Async agent launched', { id: 'a1b2', file: 'C:/Temp/tasks/a1b2.output' }],
    [
      'a path with spaces',
      { ...SHELL_RECORD, backgroundTaskId: 'b2' },
      'Output is being written to: C:/Users/A B/t/b2.output.',
      { id: 'b2', file: 'C:/Users/A B/t/b2.output' },
    ],
    ['a shell that ran in the foreground', { stdout: 'ok', stderr: '', interrupted: false }, 'ok', undefined],
    ['a shell record whose text names no file', SHELL_RECORD, 'started', undefined],
    ['the start text without a record', 'x', SHELL_TEXT, undefined],
    ['an agent that finished', { ...AGENT_RECORD, status: 'completed' }, '', undefined],
  ]
  for (const [name, record, text, want] of cases) expect([name, startedRun(record, text)]).toEqual([name, want])
})

test('a task notification names the runs it reports on', () => {
  expect(notifiedIds(ENDED)).toEqual(['b1'])
  expect(notifiedIds('no tags here')).toEqual([])
})

// Runs are measured once a minute, so the PR poll beneath them need not tick more often.
const MANIFEST = JSON.stringify({ userConfig: { pollSeconds: { type: 'number' } } })
const SETTINGS = 'C:/Users/me/.claude/mods-data/ci-watch/settings.json'

async function startShell($: Engine, on: Parameters<typeof world>[0]) {
  const { seen, clock } = world(on)
  seen.isReadable = true
  seen.manifest = MANIFEST
  seen.files.set(SETTINGS, '{"pollSeconds":60}')
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seen.toolAnswer = { result: SHELL_RECORD, text: SHELL_TEXT }
  seen.sizes.set(FILE, 10)
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true } as never)
  seen.toolAnswer = undefined
  return { seen, clock }
}

const quietWakes = (prompts: string[]) => prompts.filter(p => p.includes('has written nothing'))

test('a background run whose output stops growing wakes the session once, with its output file', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  await clock.advance(QUIET_MS - MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
  await clock.advance(2 * MINUTE)
  const wakes = quietWakes(seen.prompts)
  expect(wakes).toHaveLength(1)
  expect(wakes[0]).toContain('"npm test" (b1)')
  expect(wakes[0]).toContain(FILE)
  await clock.advance(QUIET_MS)
  expect(quietWakes(seen.prompts)).toHaveLength(1)
})

test('a run whose output keeps growing never wakes the session', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  for (let minute = 1; minute <= 45; minute++) {
    seen.sizes.set(FILE, 10 + minute)
    await clock.advance(MINUTE)
  }
  expect(quietWakes(seen.prompts)).toEqual([])
})

test('a run that reported back between turns is forgotten, however long its output stays the same', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  await $.prompt.submit({ text: ENDED, origin: { kind: 'task-notification' } } as never)
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
})

test('a run that reported back mid-turn is forgotten too', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  const message = { role: 'user', content: [{ type: 'text', text: ENDED }] }
  await $.session.append({ message, door: 'delivery', origin: { kind: 'engine' }, uuid: 'u1' } as never)
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
})

test('a run the session stopped itself never wakes it', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' } as never)
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
})

test('a notification that lands while the runs are measured is not undone', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  let isSent = false
  seen.duringStat = async () => {
    if (isSent) return
    isSent = true
    await $.prompt.submit({ text: ENDED, origin: { kind: 'task-notification' } } as never)
  }
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(isSent).toBe(true)
  expect(quietWakes(seen.prompts)).toEqual([])
})

test('a refused wake is sent again at the next check', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  await clock.advance(QUIET_MS - MINUTE)
  seen.refusals = 1
  await clock.advance(2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
  await clock.advance(2 * MINUTE)
  expect(quietWakes(seen.prompts)).toHaveLength(1)
})

test('a quiet wake due mid-turn rides one tool result, even when two finish at once', async ($, on) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'text' }) as never)
  const { seen, clock } = await startShell($, on)
  await $.turn.start({ turnId: 't1', prompt: 'work' } as never)
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
  const read = () => $.tool.call({ tool: 'Read', file_path: 'C:/repo/a.ts' } as never)
  const answers = await Promise.all([read(), read()])
  expect(answers.flatMap(answer => quietWakes([...(answer.context ?? [])]))).toHaveLength(1)
})

test("a subagent's own background start is not the session's to watch", async ($, on) => {
  const { seen, clock } = world(on)
  seen.isReadable = true
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seen.toolAnswer = { result: SHELL_RECORD, text: SHELL_TEXT }
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, agentId: 'x1' } as never)
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
})

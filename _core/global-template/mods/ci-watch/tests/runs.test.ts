import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { notifiedIds, QUIET_MS, startedRun } from '../hooks/runs'
import { world } from './world'

const MINUTE = 60_000
const FILE = 'C:/Temp/tasks/b1.output'
const SHELL_START =
  `Command running in background with ID: b1. Output is being written to: ${FILE}. ` +
  'You will be notified when it completes.'
const AGENT_START =
  'Async agent launched successfully.\nagentId: a1b2 (internal ID)\nThe agent is working in the background.\n' +
  'output_file: C:/Temp/tasks/a1b2.output\nDo NOT Read or tail this file.'

test('a background start is read from the shell and the agent answers, and nothing else', () => {
  expect(startedRun(SHELL_START)).toEqual({ id: 'b1', file: FILE })
  expect(startedRun(AGENT_START)).toEqual({ id: 'a1b2', file: 'C:/Temp/tasks/a1b2.output' })
  const spaced = 'running in background with ID: b2. Output is being written to: C:/Users/A B/t/b2.output.'
  expect(startedRun(spaced)).toEqual({ id: 'b2', file: 'C:/Users/A B/t/b2.output' })
  expect(startedRun('Everything up-to-date')).toBeUndefined()
})

test('a task notification names the runs it reports on', () => {
  const text = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'
  expect(notifiedIds(text)).toEqual(['b1'])
  expect(notifiedIds('no tags here')).toEqual([])
})

async function startShell($: Engine, on: Parameters<typeof world>[0]) {
  const { seen, clock } = world(on)
  seen.isReadable = true
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seen.toolText = SHELL_START
  seen.sizes.set(FILE, 10)
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true } as never)
  seen.toolText = undefined
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

test('a run that reported back is forgotten, however long its output stays the same', async ($, on) => {
  const { seen, clock } = await startShell($, on)
  const text = '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>'
  await $.prompt.submit({ text, origin: { kind: 'task-notification' } } as never)
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
})

test("a subagent's own background start is not the session's to watch", async ($, on) => {
  const { seen, clock } = world(on)
  seen.isReadable = true
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  seen.toolText = SHELL_START
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, agentId: 'x1' } as never)
  await clock.advance(QUIET_MS + 2 * MINUTE)
  expect(quietWakes(seen.prompts)).toEqual([])
})

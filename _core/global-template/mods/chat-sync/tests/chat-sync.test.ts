import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/repo'
const CHATS = 'C:/Users/me/.claude/projects/C--repo'
const TRANSCRIPT = `${CHATS}/sess-1.jsonl`
const MINUTE = 60_000

type World = { runs: string[][]; toasts: string[]; clock: ReturnType<typeof mock.clock> }

// The helper answers each command with the JSON line given for it.
function world(on: On, answers: Record<string, unknown> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 23, 12, 0, 0) })
  const seen: World = { runs: [], toasts: [], clock }
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.info', () => ({ value: { transcriptPath: TRANSCRIPT } as never }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } as never }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(2)
    seen.runs.push([...args])
    const stdout = `${JSON.stringify(answers[args[0] ?? ''] ?? {})}\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return seen
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

async function endTurn($: Engine): Promise<void> {
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
}

test('a session start brings newer chats in, and says how to load the open chat when it is behind', async ($, on) => {
  const seen = world(on, { in: { imported: ['other'], conflicts: [], behind: ['sess-1'], openElsewhere: [] } })
  await start($)

  expect(seen.runs).toEqual([['in', CHATS, ROOT, 'sess-1']])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('1 newer chat from your other computer')
  expect(seen.toasts[0]).toContain('start a new session in this project, then /resume this chat')
})

test('turns copy the chat out at most once a minute, and a copy that fails says so', async ($, on) => {
  const seen = world(on, { out: { error: 'EBUSY: the sync folder is locked' } })
  await start($)
  const outs = () => seen.runs.filter(args => args[0] === 'out')

  await endTurn($)
  await seen.clock.advance(1)
  expect(outs()).toEqual([['out', TRANSCRIPT, ROOT]])
  expect(seen.toasts.at(-1)).toContain('could not copy this chat out: EBUSY')

  await endTurn($)
  await endTurn($)
  await seen.clock.advance(MINUTE / 2)
  expect(outs()).toHaveLength(1)
  await seen.clock.advance(MINUTE / 2)
  expect(outs()).toHaveLength(2)
})

test('the session end copies the chat out and releases its lock', async ($, on) => {
  const seen = world(on, { out: { same: 'sess-1' } })
  await start($)
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)

  expect(seen.runs.at(-1)).toEqual(['out', TRANSCRIPT, ROOT, 'release'])
  expect(seen.toasts).toEqual([])
})

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/repo'
const CHATS = 'C:/Users/me/.claude/projects/C--repo'
const TRANSCRIPT = `${CHATS}/sess-1.jsonl`
const MINUTE = 60_000

type World = {
  runs: string[][]; toasts: string[]; clock: ReturnType<typeof mock.clock>
  // For each run: the time the helper was given to answer in, and the hook's own limit.
  limits: { answerInMs: number; timeoutMs: number }[]
}

// The helper answers each command with the JSON line given for it, or, for a
// command named in `stops`, exits with that code and prints nothing.
function world(on: On, answers: Record<string, unknown> = {}, stops: Record<string, number> = {},
  outDone: Promise<void> = Promise.resolve()): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 23, 12, 0, 0) })
  const seen: World = { runs: [], toasts: [], clock, limits: [] }
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
  on('process.run', async ($, e) => {
    const args = e.argv.slice(2)
    seen.runs.push([...args])
    const answerInMs = Number(e.init?.env?.CHAT_SYNC_DEADLINE) - clock.now()
    seen.limits.push({ answerInMs, timeoutMs: e.init?.timeoutMs ?? 30_000 })
    if (args[0] === 'out') await outDone
    const stop = stops[args[0] ?? '']
    const stdout = stop === undefined ? `${JSON.stringify(answers[args[0] ?? ''] ?? {})}\n` : ''
    const exitCode = stop ?? 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  const seen = world(on, { in: { imported: ['other'], conflicts: [], behind: ['sess-1'], sent: [] } })
  await start($)

  expect(seen.runs).toEqual([['in', CHATS, ROOT, 'sess-1']])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('1 newer chat from your other computer')
  expect(seen.toasts[0]).toContain('start a new session in this project, then /resume this chat')
})

test('a session start that ran out of time says the next one goes on', async ($, on) => {
  const seen = world(on, { in: { imported: [], conflicts: [], behind: [], sent: ['a'], more: true } })
  await start($)
  expect(seen.toasts).toEqual(
    ['Chat sync: more chats are still to sync, and the next session start goes on with them.'])
})

test('a push that fails at session start says so, and so does a helper that stops', async ($, on) => {
  const seen = world(on, { in: { imported: [], conflicts: [], behind: [], sent: ['other'], pushError: 'rejected' } },
    { out: 1 })
  await start($)
  expect(seen.toasts).toEqual(['Chat sync: could not push the chat repo: rejected.'])

  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(seen.toasts.at(-1)).toContain('the helper stopped (exit code 1)')
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

test('a turn or the session end while a copy is still running starts no second copy', async ($, on) => {
  let finish = () => {}
  const seen = world(on, { out: { same: 'sess-1' } }, {}, new Promise<void>(resolve => { finish = resolve }))
  await start($)
  await endTurn($)
  await seen.clock.advance(1)
  await endTurn($)
  await seen.clock.advance(MINUTE * 2)
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(seen.runs.filter(args => args[0] === 'out')).toHaveLength(1)
  finish()
})

test('the session end copies the chat out', async ($, on) => {
  const seen = world(on, { out: { same: 'sess-1' } })
  await start($)
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)

  expect(seen.runs.at(-1)).toEqual(['out', TRANSCRIPT, ROOT])
  expect(seen.toasts).toEqual([])
  // The helper must answer inside the session end's short bound, with room left.
  expect(seen.limits.at(-1)).toEqual({ answerInMs: 6_000, timeoutMs: 8_000 })
})

test('a copy queued by the last turn does not run after the session end sent the chat', async ($, on) => {
  const seen = world(on, { out: { same: 'sess-1' } })
  await start($)
  await endTurn($)
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  await seen.clock.advance(MINUTE)

  expect(seen.runs.filter(args => args[0] === 'out')).toEqual([['out', TRANSCRIPT, ROOT]])
})

test('a folder path with spaces reaches the helper whole', async ($, on) => {
  const seen = world(on, { move: { moved: 0 } })
  await start($)
  await $.command.run({ command: 'chat-sync', args: 'move folder "C:/Users/al/My Drive/Claude chats"' } as never)

  expect(seen.runs.at(-1)).toEqual(['move', 'folder', 'C:/Users/al/My Drive/Claude chats'])
})

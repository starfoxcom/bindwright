// Background runs this session started (a shell or a subagent) that have not reported back. Each one's output
// file is measured once a minute, and a run that has written nothing for QUIET_MS wakes the session once, so a
// hung or killed run is not waited on forever.

import { atom, read, update, type EngineInterface, type On } from 'claude-code'

import type { Run } from '../types'

/** How long a run's output may stay the same size before the session hears about it. */
export const QUIET_MS = 30 * 60_000
const CHECK_EVERY_MS = 60_000

const runs = atom({ plugin: 'ci-watch', key: 'runs' } as const, [])
const live = { notes: [] as string[], checkedAt: 0 }

type Started = { id: string; file: string }

// What the engine answers when it starts one, for a shell ("Command running in background with ID: <id>.
// Output is being written to: <file>.") and for an agent ("agentId: <id> ... output_file: <file>").
const SHELL_START = /running in background with ID: ([\w-]+)[\s\S]*?Output is being written to: (.+?\.output)/
const AGENT_START = /agentId: ([\w-]+)[\s\S]*?output_file: (.+?\.output)/
const NOTIFIED = /<task-id>([\w-]+)<\/task-id>/g

/** The run a tool result started, or none. */
export function startedRun(resultText: string): Started | undefined {
  const [, id, file] = SHELL_START.exec(resultText) ?? AGENT_START.exec(resultText) ?? []
  return id && file ? { id, file: file.trim() } : undefined
}

/** The ids a task notification reports on. */
export const notifiedIds = (text: string): string[] => [...text.matchAll(NOTIFIED)].map(match => match[1] ?? '')

/** The wake for a run that went quiet. */
export function quietText(run: Run, now: number): string {
  const minutes = Math.round((now - run.grewAt) / 60_000)
  return (
    `[ci-watch] The background run "${run.label}" (${run.id}) has written nothing for ${minutes} min and has ` +
    `not reported back. Read the end of ${run.file} to see whether it hung, then stop it or keep waiting.`
  )
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))

function labelOf(input: Record<string, unknown>): string {
  const label = String(input.description ?? input.command ?? input.prompt ?? 'background run')
  return label.length > 60 ? `${label.slice(0, 57)}...` : label
}

/** Records a background run a tool call started, from its result. */
export async function noteStart($: EngineInterface, input: unknown, result: unknown): Promise<void> {
  const started = startedRun(textOf(result))
  if (!started) return
  const now = await $.clock.now()
  const run: Run = { ...started, label: labelOf((input ?? {}) as Record<string, unknown>), size: -1, grewAt: now }
  await update($, runs, list => [...list.filter(other => other.id !== run.id), run])
}

/** The wakes held for the running turn, taken once. */
export function takeRunNotes(): string[] {
  return live.notes.splice(0)
}

// One output file's size; a file that cannot be read has not grown.
function sizeOf($: EngineInterface, file: string): Promise<number> {
  return $.fs.stat(file).then(stat => stat.size, () => -1)
}

/** Measures the open runs at most once a minute; the poll of the instance that owns the session calls it. */
export async function checkRuns($: EngineInterface, isTurnRunning: boolean): Promise<void> {
  const now = await $.clock.now()
  if (now - live.checkedAt < CHECK_EVERY_MS) return
  live.checkedAt = now
  const quiet: Run[] = []
  const measured: Run[] = []
  for (const run of await read($, runs)) {
    const size = run.isReported ? run.size : await sizeOf($, run.file)
    if (size > run.size) measured.push({ ...run, size, grewAt: now })
    else if (!run.isReported && now - run.grewAt >= QUIET_MS) {
      quiet.push(run)
      measured.push({ ...run, isReported: true })
    } else measured.push(run)
  }
  await update($, runs, () => measured)
  // Held while a turn runs, for its next tool result; sent between turns, held ones included.
  live.notes.push(...quiet.map(run => quietText(run, now)))
  if (isTurnRunning) return
  for (const text of live.notes.splice(0)) await $.prompt.submit({ text }).catch(() => undefined)
}

/** Drops the runs a task notification reports on. */
export function registerRuns(on: On): void {
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const ended = new Set(notifiedIds(e.text))
      if (ended.size > 0) await update($, runs, list => list.filter(run => !ended.has(run.id)))
    }
    return next(e)
  })
}

/** Records a background run the main session's tool call started. */
export async function noteRun($: EngineInterface, call: { agentId?: string }, result: { result?: unknown }) {
  if (call.agentId === undefined) await noteStart($, call, result.result)
}

// Background runs this session started (a shell or a subagent) that have not reported back. Each one's output
// file is measured once a minute, and a run that has written nothing for QUIET_MS wakes the session once, so a
// hung or killed run is not waited on forever.

import { atom, read, update, type EngineInterface, type On } from 'claude-code'

import type { Run } from '../types'

/** How long a run's output may stay the same size before the session hears about it. */
export const QUIET_MS = 30 * 60_000
const CHECK_EVERY_MS = 60_000
// Sends per wake: a hook that drops every prompt is not asked again each minute.
const MAX_TRIES = 3

const runs = atom({ plugin: 'ci-watch', key: 'runs' } as const, [])
const live = { checkedAt: 0 }

type Started = { id: string; file: string }

// A shell's record names only its id; the text the model reads names its output file.
const SHELL_FILE = /Output is being written to: (.+?\.output)/
const NOTIFIED = /<task-id>([\w-]+)<\/task-id>/g

/** The run a tool call started, from the tool's own record and the text the model reads, or none. */
export function startedRun(record: unknown, text: string): Started | undefined {
  const fields = (record ?? {}) as Record<string, unknown>
  const { agentId, outputFile, backgroundTaskId } = fields
  if (fields.status === 'async_launched' && typeof agentId === 'string' && typeof outputFile === 'string') {
    return { id: agentId, file: outputFile }
  }
  const file = SHELL_FILE.exec(text)?.[1]?.trim()
  return typeof backgroundTaskId === 'string' && file ? { id: backgroundTaskId, file } : undefined
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

function labelOf(input: Record<string, unknown>): string {
  const label = String(input.description ?? input.command ?? input.prompt ?? 'background run')
  return label.length > 60 ? `${label.slice(0, 57)}...` : label
}

/** Records a background run the main session's tool call started. */
export async function noteRun(
  $: EngineInterface,
  call: { agentId?: string },
  answer: { result?: unknown; text?: string },
): Promise<void> {
  if (call.agentId !== undefined) return
  const started = startedRun(answer.result, answer.text ?? '')
  if (!started) return
  const now = await $.clock.now()
  const run: Run = { ...started, label: labelOf(call as Record<string, unknown>), size: -1, grewAt: now }
  await update($, runs, list => [...list.filter(other => other.id !== run.id), run])
}

// One output file's size; a file that cannot be read has not grown.
function sizeOf($: EngineInterface, file: string): Promise<number> {
  return $.fs.stat(file).then(stat => stat.size, () => -1)
}

// Lays each changed run over the list as it stands now, by id: a run dropped or added meanwhile stays so.
async function merge($: EngineInterface, changed: Run[]): Promise<void> {
  if (changed.length === 0) return
  const byId = new Map(changed.map(run => [run.id, run]))
  await update($, runs, list => list.map(run => byId.get(run.id) ?? run))
}

/** Measures the open runs at most once a minute; the poll of the instance that owns the session calls it. */
export async function checkRuns($: EngineInterface, isTurnRunning: boolean): Promise<void> {
  const now = await $.clock.now()
  if (now - live.checkedAt < CHECK_EVERY_MS) return
  live.checkedAt = now
  const changed: Run[] = []
  for (const run of await read($, runs)) {
    if (run.isReported) continue
    const size = await sizeOf($, run.file)
    if (size > run.size) changed.push({ ...run, size, grewAt: now })
    else if (now - run.grewAt >= QUIET_MS) changed.push({ ...run, isReported: true, isWakePending: true })
  }
  await merge($, changed)
  if (!isTurnRunning) await sendRunWakes($)
}

// The wakes due, chosen and marked sent in one update, so two callers at once never take the same one.
async function takeDue($: EngineInterface): Promise<Run[]> {
  let due: Run[] = []
  await update($, runs, list => {
    due = list.filter(run => run.isWakePending)
    return due.length === 0 ? list : list.map(run => (run.isWakePending ? { ...run, isWakePending: undefined } : run))
  })
  return due
}

/** The wakes due, for the running turn's next tool result. */
export async function takeRunNotes($: EngineInterface): Promise<string[]> {
  const now = await $.clock.now()
  return (await takeDue($)).map(run => quietText(run, now))
}

// Between turns each due wake is its own prompt; a refused one is marked due again, up to MAX_TRIES sends.
async function sendRunWakes($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const run of await takeDue($)) {
    const tries = (run.wakeTries ?? 0) + 1
    void $.prompt
      .submit({ text: quietText(run, now) })
      .then(
        sent => sent.drop !== undefined,
        () => true,
      )
      .then(isRefused => (isRefused && tries < MAX_TRIES ? merge($, [{ ...run, wakeTries: tries }]) : undefined))
      .catch(() => undefined)
  }
}

async function dropNotified($: EngineInterface, text: string): Promise<void> {
  const ended = new Set(notifiedIds(text))
  if (ended.size > 0) await update($, runs, list => list.filter(run => !ended.has(run.id)))
}

// The text of an appended message, its blocks joined.
function appendedText(content: string | readonly object[]): string {
  return typeof content === 'string' ? content : content.map(b => ('text' in b ? String(b.text) : '')).join('\n')
}

/**
 * Drops the runs that ended: those a task notification reports on, submitted between turns or appended
 * mid-turn, and those the session stopped itself, which no notification reports.
 */
export function registerRuns(on: On): void {
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as { task_id?: string; shell_id?: string }
    const id = input.task_id ?? input.shell_id
    if (id && ran.deny === undefined && !ran.isError) {
      await update($, runs, list => list.filter(run => run.id !== id))
    }
    return ran
  })
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') await dropNotified($, e.text)
    return next(e)
  })
  on('session.append', async ($, e, next) => {
    if (e.door !== 'response') {
      const text = appendedText(e.message.content as string | readonly object[])
      if (text.includes('<task-id>')) await dropNotified($, text)
    }
    return next(e)
  })
}

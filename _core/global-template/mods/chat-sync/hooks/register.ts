import type { EngineInterface, Register } from 'claude-code'

// Keeps this computer's chats in step with a sync place (a folder a sync app
// keeps in step, or a private git repo): newer chats come in when a session
// starts, and the open chat goes out after a turn and when the session ends.
// The copying runs in scripts/sync.cjs, outside the mod's sandbox.

const SCRIPT = 'scripts/sync.cjs'
// At most one copy out a minute: a long chat is read whole on every copy.
const OUT_EVERY_MS = 60_000
// The session's end gives every hook one short shared bound.
const END_TIMEOUT_MS = 8_000
const COMMAND = 'chat-sync'
const HINT = '[status | places | move folder <path> | move git <owner/repo> | move off]'
const HELP = [
  'Chat sync keeps your chats in step across computers: start Claude Code in the project, '
    + 'then /resume finds a chat started on another one.',
  '/chat-sync status: where the chats sync and how many this project has.',
  '/chat-sync places: the sync folders found on this computer.',
  '/chat-sync move folder <path>: sync through that folder (Google Drive, OneDrive, Dropbox, '
    + 'iCloud Drive, Syncthing...).',
  '/chat-sync move git <owner/repo>: sync through a private GitHub repo.',
  '/chat-sync move off: stop syncing; the copies already made stay.',
].join('\n')

type Answer = Record<string, unknown> & { error?: string }

let lastOutAt = 0
let isOutQueued = false
// Set by the session's end, so a copy queued after the last turn does not write
// the lock back once the end has released it; the next turn clears it.
let hasEnded = false

async function runSync($: EngineInterface, args: string[], timeoutMs = 120_000): Promise<Answer> {
  try {
    const run = await $.process.run(['node', `${$.plugin.root}/${SCRIPT}`, ...args], { timeoutMs })
    const last = run.stdout.trim().split('\n').pop() || '{}'
    return JSON.parse(last) as Answer
  } catch (error) {
    return { error: String(error) }
  }
}

async function where($: EngineInterface): Promise<{ transcript: string; root: string; id: string } | null> {
  const { transcriptPath } = await $.session.info()
  if (!transcriptPath) return null
  return { transcript: transcriptPath, root: await $.session.root(), id: await $.session.id() }
}

function chatFolder(transcript: string): string {
  return transcript.replace(/[\\/][^\\/]+$/, '')
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// One short line about what came in, or nothing when nothing did.
function bringInNote(answer: Answer): string | undefined {
  const parts: string[] = []
  const imported = countOf(answer.imported)
  const conflicts = countOf(answer.conflicts)
  if (imported) parts.push(`${plural(imported, 'newer chat')} from your other computer, ready in /resume`)
  if (conflicts) parts.push(`${plural(conflicts, 'chat')} changed on both computers, so this computer's copy was kept`)
  if (countOf(answer.behind)) {
    parts.push('this chat has newer messages on your other computer: start a new session in this project, '
      + 'then /resume this chat to load them')
  }
  if (answer.error) parts.push(`could not sync: ${answer.error}`)
  return parts.length ? `Chat sync: ${parts.join('; ')}.` : undefined
}

async function bringIn($: EngineInterface): Promise<void> {
  const here = await where($)
  if (!here) return
  const answer = await runSync($, ['in', chatFolder(here.transcript), here.root, here.id])
  if (answer.skipped) return
  const note = bringInNote(answer)
  if (note) $.ui.toast(note)
}

function outNote(answer: Answer): string | undefined {
  if (answer.held) {
    return `Chat sync: this chat is open on ${String(answer.by)}, so this computer's messages stay here `
      + 'until it closes there.'
  }
  if (answer.conflict) return 'Chat sync: this chat changed on both computers; this copy was saved beside the other.'
  if (answer.pushError) return `Chat sync: could not push the chat repo: ${String(answer.pushError).slice(0, 200)}`
  if (answer.error) return `Chat sync: could not copy this chat out: ${answer.error.slice(0, 200)}`
  return undefined
}

async function copyOut($: EngineInterface, isEnding: boolean): Promise<void> {
  const here = await where($)
  if (!here) return
  const args = ['out', here.transcript, here.root, ...(isEnding ? ['release'] : [])]
  const answer = await runSync($, args, isEnding ? END_TIMEOUT_MS : 120_000)
  lastOutAt = Date.now()
  const note = outNote(answer)
  if (note) $.ui.toast(note)
}

function commandText(answer: Answer): string {
  if (answer.error) return `Chat sync: ${answer.error}`
  return '```json\n' + JSON.stringify(answer, null, 2) + '\n```'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const description = 'Chat sync: status, sync folders, or move the chats to another place.'
    await $.command.register({ name: COMMAND, description, argumentHint: HINT })
    await bringIn($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    hasEnded = false
    if (isOutQueued) return result
    isOutQueued = true
    const wait = Math.max(0, OUT_EVERY_MS - (Date.now() - lastOutAt))
    $.clock.after(wait, async () => {
      isOutQueued = false
      if (!hasEnded) await copyOut($, false)
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    hasEnded = true
    await copyOut($, true)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [word, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (word === 'status') return { text: commandText(await runSync($, ['status', await $.session.root()])) }
    if (word === 'places') return { text: commandText(await runSync($, ['places'])) }
    if (word === 'move') return { text: commandText(await runSync($, ['move', ...rest], 300_000)) }
    return { text: HELP }
  })
}

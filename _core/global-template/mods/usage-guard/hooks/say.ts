import type { EngineInterface } from 'claude-code'

import { live } from './live'
import { formatLocal, READ_ZONE, zoneOf } from './texts'

// How the mod speaks in this session: its notes in the transcript, the status line, and the local time they show.

export async function readZone($: EngineInterface): Promise<void> {
  try {
    const { exitCode, stdout } = await $.process.run(READ_ZONE, { timeoutMs: 10_000 })
    const zone = exitCode === 0 ? zoneOf(stdout) : undefined
    if (zone) live.zone = zone
  } catch {
    // UTC stays; the times shown say so.
  }
}

export function localTime(ms: number): string {
  return formatLocal(ms, live.zone)
}

// A note in this transcript; what the person sees is the card in every session (a toast vanishes).
export async function notice($: EngineInterface, text: string): Promise<void> {
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => undefined)
}

export function setStatus($: EngineInterface, text: string | undefined): void {
  $.ui.status(text)
  live.isStatusShown = text !== undefined
}

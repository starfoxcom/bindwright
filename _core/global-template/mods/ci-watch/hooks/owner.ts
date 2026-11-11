import type { Watch } from '../types'
import type { EngineInterface } from 'claude-code'

// A hot reload loads the mod again but leaves the earlier instance's timer (and old code) running beside
// the new one, and a resumed session goes on under an id whose owner file names the process that ran it
// before. Each instance's name starts with when it loaded, and the newest load owns the session: one that
// finds an older name in the owner file takes the session over, one that finds a newer name is retired
// (it stops polling and its hooks pass through). A file, not a global, because instances do not share
// one. An unreadable file retires none.
const LOADED_AT = Date.now()
const INSTANCE = `${LOADED_AT}-${Math.random().toString(36).slice(2)}`

/** Who the owner file names for the session's current id, as seen by this instance. */
export type Owner = 'this' | 'older' | 'newer' | 'none'

async function ownerFile($: EngineInterface, folder: string): Promise<string> {
  return `${folder}/${await $.session.id()}.owner`
}

/** Names this instance as the owner of the session's current id, in `folder` (which must exist). */
export async function claim($: EngineInterface, folder: string): Promise<void> {
  try {
    await $.fs.write(await ownerFile($, folder), INSTANCE)
  } catch {
    // No owner file: every instance stays active, as before.
  }
}

/** Reads the owner file of the session's current id; an unreadable or empty one names nobody. */
export async function ownerOf($: EngineInterface, folder: string): Promise<Owner> {
  try {
    const owner = String(await $.fs.read(await ownerFile($, folder))).trim()
    if (owner === '') return 'none'
    if (owner === INSTANCE) return 'this'
    return Number(owner.split('-')[0]) < LOADED_AT ? 'older' : 'newer'
  } catch {
    return 'none'
  }
}

/** The watches an earlier owner saved, joined with this load's own, which win for the same PR. */
export function joinWatches(saved: readonly Watch[], own: readonly Watch[]): Watch[] {
  const ownPrs = new Set(own.map(w => `${w.repo}#${w.number}`))
  return [...saved.filter(w => !ownPrs.has(`${w.repo}#${w.number}`)), ...own]
}

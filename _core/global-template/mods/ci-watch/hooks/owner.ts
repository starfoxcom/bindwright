import type { Watch } from '../types'
import type { EngineInterface } from 'claude-code'

// A hot reload loads the mod again but leaves the earlier instance's timer (and old code) running beside
// the new one, and a resumed session goes on under an id whose owner file names the process that ran it
// before. Each instance's name starts with when it loaded, and the newest load owns the session: one that
// finds an older name in the owner file takes the session over, one that finds a newer name is retired
// (it stops polling and its hooks pass through). A file, not a global, because instances do not share
// one. An unreadable file retires none. The owner renews the time beside its name at every poll, so a
// newer owner that stopped renewing it has exited, and a live instance takes the session back.
const LOADED_AT = Date.now()
const INSTANCE = `${LOADED_AT}-${Math.random().toString(36).slice(2)}`

/** Who the owner file names for the session's current id, as seen by this instance. */
export type Owner = 'this' | 'older' | 'newer' | 'gone' | 'none'

async function ownerFile($: EngineInterface, folder: string): Promise<string> {
  return `${folder}/${await $.session.id()}.owner`
}

/** Names this instance as the owner of the session's current id, in `folder` (which must exist), as of now. */
export async function claim($: EngineInterface, folder: string): Promise<void> {
  try {
    await $.fs.write(await ownerFile($, folder), `${INSTANCE} ${await $.clock.now()}`)
  } catch {
    // No owner file: every instance stays active, as before.
  }
}

/**
 * Reads the owner file of the session's current id; an unreadable or empty one names nobody. A newer
 * owner whose claim is older than `goneAfterMs` is `gone`; one with no time beside its name is newer.
 */
export async function ownerOf($: EngineInterface, folder: string, goneAfterMs: number): Promise<Owner> {
  try {
    const [name = '', renewedAt] = String(await $.fs.read(await ownerFile($, folder))).trim().split(/\s+/)
    if (name === '') return 'none'
    if (name === INSTANCE) return 'this'
    if (Number(name.split('-')[0]) < LOADED_AT) return 'older'
    return (await $.clock.now()) - Number(renewedAt) > goneAfterMs ? 'gone' : 'newer'
  } catch {
    return 'none'
  }
}

/** What the instance holds in memory about the session's watches, kept in the mod's live state. */
export interface Memory {
  watches: Watch[]
  /** The session id whose state file the watches in memory were loaded from or saved to. */
  stateId: string | undefined
  isUnsaved: boolean
  generation: number
}

/**
 * When the session goes on under another id (a resume), joins the watches saved under that id into memory,
 * and marks memory unsaved, so the next poll keeps it and the next save writes both. For a PR both hold,
 * the copy further along wins: the saved one when it settled the same head (it may hold a wake not yet
 * sent), this load's otherwise. Returns whether it joined anything. Called from the entry check every hook
 * and poll passes, before anything changes memory.
 */
export async function followId($: EngineInterface, folder: string, memory: Memory): Promise<boolean> {
  const id = await $.session.id()
  if (memory.stateId === undefined || memory.stateId === id) return false
  let saved: Watch[] = []
  try {
    saved = (JSON.parse(String(await $.fs.read(`${folder}/${id}.json`))) as { watches?: Watch[] }).watches ?? []
  } catch {
    // No file under that id: nothing to join.
  }
  const prOf = (w: Watch) => `${w.repo}#${w.number}`
  const savedByPr = new Map(saved.map(w => [prOf(w), w]))
  const own = memory.watches.map(w => {
    const there = savedByPr.get(prOf(w))
    if (!there || there.headSha !== w.headSha || !there.outcome || w.outcome) return w
    // A step back latched in memory stays unless the saved copy went green, which ends it.
    return there.outcome === 'passed' ? there : { ...there, stepBackTopics: w.stepBackTopics ?? there.stepBackTopics }
  })
  const ownPrs = new Set(own.map(prOf))
  memory.watches = [...saved.filter(w => !ownPrs.has(prOf(w))), ...own]
  memory.stateId = id
  memory.isUnsaved = true
  memory.generation++
  return true
}

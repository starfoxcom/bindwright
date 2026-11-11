import type { EngineInterface } from 'claude-code'

// A hot reload loads the mod again but leaves the earlier instance's timer (and old code) running beside
// the new one. The instance that starts polling last names itself in the session's owner file; one that
// finds another name there is retired: it stops polling and its hooks pass through. A file, not a global,
// because instances do not share one. An unreadable file retires none.
const INSTANCE = `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** What an instance knows about its own claim, kept in the mod's live state. */
export interface Claim {
  /** The session id the owner file was written under: a resume can carry the session on under another. */
  claimedId: string | undefined
  /** The id a /clear ended. */
  endedId: string | undefined
  isRetiredForGood: boolean
}

const ownerFile = (folder: string, id: string) => `${folder}/${id}.owner`

/** Names this instance as the owner of the session's current id, in `folder` (which must exist). */
export async function claim($: EngineInterface, folder: string, live: Claim): Promise<void> {
  try {
    const id = await $.session.id()
    await $.fs.write(ownerFile(folder, id), INSTANCE)
    live.claimedId = id
  } catch {
    // No owner file: every instance stays active, as before.
  }
}

// A resumed session can go on under the id it resumes after session.start claimed a fresh one, and that
// id's owner file still names the process that ran it before. The instance that still owns the id it
// claimed carries the claim to the new one; a retired instance, or one whose id a /clear ended, does not.
async function followResume($: EngineInterface, folder: string, live: Claim): Promise<void> {
  const claimed = live.claimedId
  if (claimed === undefined || claimed === live.endedId || claimed === (await $.session.id())) return
  if (String(await $.fs.read(ownerFile(folder, claimed))).trim() === INSTANCE) await claim($, folder, live)
}

/** Whether a newer instance has taken the session over, so this one's hooks pass through. */
export async function isRetired($: EngineInterface, folder: string, live: Claim): Promise<boolean> {
  if (live.isRetiredForGood) return true
  try {
    await followResume($, folder, live)
    const owner = String(await $.fs.read(ownerFile(folder, await $.session.id()))).trim()
    return owner !== '' && owner !== INSTANCE
  } catch {
    return false
  }
}

import type { EngineInterface } from 'claude-code'

// A hot reload loads the mod again but leaves the earlier instance's timer (and old code) running beside
// the new one, and a resumed session goes on under an id whose owner file names the process that ran it
// before. Each instance's name starts with when it loaded, and the newest load owns the session: one that
// finds an older name in the owner file takes the session over, one that finds a newer name is retired
// (it stops polling and its hooks pass through). A file, not a global, because instances do not share
// one. An unreadable file retires none.
const LOADED_AT = Date.now()
const INSTANCE = `${LOADED_AT}-${Math.random().toString(36).slice(2)}`

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

/** Whether a newer load owns the session, so this instance's hooks pass through. */
export async function isRetired($: EngineInterface, folder: string): Promise<boolean> {
  try {
    const owner = String(await $.fs.read(await ownerFile($, folder))).trim()
    if (owner === '' || owner === INSTANCE) return false
    if (Number(owner.split('-')[0]) < LOADED_AT) {
      await claim($, folder)
      return false
    }
    return true
  } catch {
    return false
  }
}

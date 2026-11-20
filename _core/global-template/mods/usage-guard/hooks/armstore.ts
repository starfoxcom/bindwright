import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ArmedWake } from '../types'
import { catchUpOf, caughtUpText, missedArmText, parseSavedArm } from './arms'
import { dataDir, readJson } from './files'
import { live } from './live'
import { armFor, type DisarmAll, isDisarmedByAll } from './plan'
import { localTime, notice } from './say'

// This session's arm: in plugin state, so a hot reload keeps it, and in `mods-data/usage-guard/arms/<session>.json`,
// so a restart finds it again (the arm, or `null` once it is dropped or done: mods cannot delete files).

const armedWake = atom({ plugin: 'usage-guard', key: 'armed' } as const, null)
const MKDIR_SCRIPT = 'require("fs").mkdirSync(process.argv[1],{recursive:true})'

// The arm in plugin state names the session its saved copy is filed under. A hot reload keeps that state
// while it starts this module over, and a /clear changes the id, so every save and move reads the file
// from the arm itself: the copy under an earlier id is always the one cleared. An arm whose save failed
// keeps naming the earlier file while that may still hold it, so the next save or disarm clears it.
export async function setArm($: EngineInterface, arm: ArmedWake | null): Promise<void> {
  const before = await read($, armedWake)
  // The project folder too: a later session there is offered the arm if this one closes before its wake.
  const filed = arm && { ...arm, session: await $.session.id(), root: arm.root ?? (await $.session.root()) }
  await update($, armedWake, () => filed)
  const isSaved = await saveArm($, filed, before?.session)
  if (isSaved || !filed || !before?.session) return
  const isSame = (now: ArmedWake | null) => now?.session === filed.session && now.wakeAt === filed.wakeAt
  await update($, armedWake, now => (now && isSame(now) ? { ...now, session: before.session } : now))
}

export async function armPath($: EngineInterface, sessionId?: string): Promise<string> {
  return `${await dataDir($)}/arms/${sessionId ?? (await $.session.id())}.json`
}

// False when a write failed, never a throw: the arm still stands in this process. The earlier copy is
// cleared first, in the folder that already holds it, so a failed folder check never leaves it live.
async function saveArm($: EngineInterface, arm: ArmedWake | null, earlier?: string): Promise<boolean> {
  try {
    if (!arm) return (await $.fs.write(await armPath($, earlier), 'null'), true)
    if (earlier && earlier !== arm.session) await $.fs.write(await armPath($, earlier), 'null')
    if (!live.isArmsDirMade) {
      const made = await $.process.run(['node', '-e', MKDIR_SCRIPT, `${await dataDir($)}/arms`], { timeoutMs: 10_000 })
      live.isArmsDirMade = made.exitCode === 0
      if (!live.isArmsDirMade) return false // Tried again at the next save.
    }
    await $.fs.write(await armPath($, arm.session), JSON.stringify(arm, null, 2))
    return true
  } catch {
    return false
  }
}

// A /clear moves the session to a new id with no session.start: the saved copy follows the standing arm
// there (the classic SessionStart hook sees the new id; the next turn or minute check catch a miss), so a
// restart that resumes the newest conversation still finds it.
export async function followSession($: EngineInterface, sessionId?: string): Promise<void> {
  const arm = await read($, armedWake)
  const current = sessionId ?? (await $.session.id())
  if (!arm?.session || arm.session === current) return
  // State moves only once the copy has: a failed save is tried again by the next turn or minute check.
  const moved = { ...arm, session: current }
  if (!(await saveArm($, moved, arm.session))) return
  await update($, armedWake, now => (now?.session === arm.session ? moved : now))
}

// A session started again (a restart, a resume) finds the arm it saved: scheduled again, caught up
// within the setting's window, or dropped with a note. A hot reload keeps the arm in state instead.
export async function restoreArm($: EngineInterface): Promise<ArmedWake | undefined> {
  const text = await $.fs.read(await armPath($)).catch(() => '')
  const parsed = parseSavedArm(String(text))
  if (!parsed) return undefined
  const saved = { ...parsed, session: await $.session.id() }
  if (isDisarmedByAll(saved, await readDisarmAll($))) return void (await setArm($, null))
  const action = catchUpOf(saved.wakeAt, await $.clock.now(), live.catchUpMinutes)
  if (action === 'drop') {
    await setArm($, null)
    await notice($, missedArmText(armFor(saved.kind), localTime(saved.wakeAt), live.catchUpMinutes))
    return undefined
  }
  await update($, armedWake, () => saved)
  if (action === 'fire') await notice($, caughtUpText(armFor(saved.kind), localTime(saved.wakeAt)))
  return saved
}

export async function readDisarmAll($: EngineInterface): Promise<DisarmAll | undefined> {
  return readJson<DisarmAll>($, `${await dataDir($)}/disarm.json`)
}

export async function writeDisarmAll($: EngineInterface, at: number): Promise<void> {
  await $.fs.write(`${await dataDir($)}/disarm.json`, JSON.stringify({ at } satisfies DisarmAll, null, 2))
}

/** Drops this session's arm when a disarm of every session came after it was set; true when it did. */
export async function dropIfDisarmedByAll($: EngineInterface): Promise<boolean> {
  const arm = await read($, armedWake)
  if (!arm || !isDisarmedByAll(arm, await readDisarmAll($))) return false
  live.armTimer?.cancel()
  live.armTimer = undefined
  await setArm($, null)
  await notice($, 'Disarmed with every session: this session will not resume on its own.')
  return true
}

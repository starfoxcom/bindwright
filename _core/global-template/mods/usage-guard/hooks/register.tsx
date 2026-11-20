import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArmedWake, UsageCard } from '../types'
import { parseSavedArm, quietResumePrompt, quietResumeText } from './arms'
import { armPath, dropIfDisarmedByAll, followSession, readMark, restoreArm, setArm, writeMark } from './armstore'
import { switchCardText } from './account'
import { clearSwitchCard, endIfSwitched, isLiftAsked, meetSwitch, noteReading } from './switch'
import { raiseSwitchCard, seeLogin } from './switch'
import type { CompactOutcome, Fill } from './compact'
import { measured, outcomeMark, outcomeOf, outcomeText, PAUSE_INSTRUCTIONS, shouldCompactAtPause } from './compact'
import { closeCommand, limitName, type Pause } from './plan'
import { armFor, bringForward, CLAIM, countOpenTasks, covers, EMPTY_ARM_NOTE, hotLimits, isResetEarly } from './plan'
import { fenceAfter, joinPause, unfenced } from './plan'
import { armForPause, declinePauseArm, readPauseArm, takePauseArm } from './pausearm'
import { NO_WORK_NOTICE, planPause, projectOf, reasonText, resetKey, resumePrompt, WRAP_UP_ARGS } from './plan'
import { stopCommandsFor } from './rules'
import { dataDir, pausePath, readFence, readJson, readPause, writeFence, writePause } from './files'
import { drawArmLine, drawCards } from './cards'
import { register as adopt } from './adopt'
import { register as phone } from './phone'
import { applyFile, register as settings, SETTINGS_PANE } from './settings'
import type { Card, CardButton } from './texts'
import { applyValues, live } from './live'
import { localTime, notice, readZone, setStatus } from './say'
import { ARGUMENT_HINT, armLineText, CANCELLED_TEXT, cardTone, COMMAND_TEXT, HELP } from './texts'
import { armedText, joinedPauseText, pausedText, questionText, statusText } from './texts'
import { finishStepText, nothingToSaveText, savingText, UNCONFIRMED_NOTICE } from './texts'
import { parseSaved, SAVED_FILE, savedRecord } from './saved'
import { ARM_TOOL, ARM_TOOL_NAME, type ArmRequest, parseArmArgs, planWake, toolRequest, untilText } from './wake'

const CHECK_EVERY_MS = 60_000
// A beat after a command or the wrap-up's turn ends before compacting, so the engine is between turns.
const COMPACT_DELAY_MS = 1_000
// How often the card re-reads the shared files, so a Dismiss or a cancel elsewhere shows here.
const REFRESH_MS = 2_000
const band = atom({ plugin: 'usage-guard', key: 'band' } as const, null)
// The same state armstore.ts saves: the engine lists what each file reads, so each names it itself.
const armedWake = atom({ plugin: 'usage-guard', key: 'armed' } as const, null)
const armNote = atom({ plugin: 'usage-guard', key: 'armNote' } as const, null)
const accountView = atom({ plugin: 'usage-guard', key: 'account' } as const, null)

async function runClaimHelper($: EngineInterface, name: string): Promise<{ exitCode: number; stdout: string }> {
  return $.process.run(['node', '-e', CLAIM, await dataDir($), name.replace(/[^\w-]/g, '_')], { timeoutMs: 10_000 })
}

// True when this session won the claim, false when it was taken, null when the helper failed and
// nothing reached the disk.
async function tryClaim($: EngineInterface, name: string): Promise<boolean | null> {
  if (live.handled.has(name)) return false
  live.handled.add(name)
  try {
    const { exitCode, stdout } = await runClaimHelper($, name)
    return exitCode === 0 ? stdout.trim() !== 'taken' : null
  } catch {
    return null
  }
}

// A helper that fails counts as a win, as before claims existed, so a missing `node` never stops the wrap-up.
async function claim($: EngineInterface, name: string): Promise<boolean> {
  return (await tryClaim($, name)) !== false
}

async function cardPath($: EngineInterface): Promise<string> {
  return (await pausePath($)).replace(/pause\.json$/, 'card.json')
}

const readCard = async ($: EngineInterface) => readJson<UsageCard>($, await cardPath($))

// One card per event, shared by every session: the first session to reach the event writes it, so a card someone
// already dismissed is not raised again by the next session reaching the same event.
async function showCard($: EngineInterface, id: string, text: string): Promise<void> {
  if ((await readCard($))?.id === id) return
  await $.fs.write(await cardPath($), JSON.stringify({ id, text, dismissed: false }, null, 2))
  await refresh($)
}

async function dismissCard($: EngineInterface): Promise<void> {
  const card = await readCard($)
  if (card && !card.dismissed)
    await $.fs.write(await cardPath($), JSON.stringify({ ...card, dismissed: true }, null, 2))
  await refresh($)
}

// Runs every 2 seconds, so an idle tick (no card, no status shown) reads one file and writes nothing.
async function refresh($: EngineInterface): Promise<void> {
  const card = await readCard($)
  const shown = card && !card.dismissed ? card : null
  // The pause matters only for a card's cancel button and for a status this session shows.
  const pause = shown || live.isStatusShown ? await readPause($) : undefined
  const isPaused = pause?.status === 'active' && pause.wakeAt > (await $.clock.now())
  // A pause cancelled or ended from another session clears this one's status too.
  if (!isPaused && live.isStatusShown) setStatus($, undefined)
  const own = shown ? await readPauseArm($) : null
  const hasOwnResume = Boolean(own && !own.isDeclined && own.hasWork)
  const canDisarmHere = shown ? hasOwnResume || (await read($, armedWake)) !== null : false
  const next = shown ? { card: shown, canCancel: isPaused, canDisarmHere } : null
  if (JSON.stringify(await read($, band)) !== JSON.stringify(next)) await update($, band, () => next)
}

// Every session's arm goes, the ones set by hand included: each session drops its own at its next check, or at
// its wake at the latest. An active pause turns cancelled, so nothing waits on it any more.
async function disarmGlobal($: EngineInterface): Promise<string> {
  await writeMark($, 'disarm', await $.clock.now())
  await disarm($)
  const pause = await readPause($)
  if (pause?.status === 'active') {
    await writePause($, { ...pause, status: 'cancelled' })
    setStatus($, undefined)
    await showCard($, `cancelled:${pause.resetsAt}`, CANCELLED_TEXT)
  }
  return 'Disarmed every session: none resumes on its own.'
}

// Every session stops its own project's background work, once per project per reset: sessions in two
// projects each stop their own, and of two sessions in one project only the first runs the commands.
async function stopBackground($: EngineInterface, pause: Pause): Promise<void> {
  const root = await $.session.root()
  if (!(await claim($, `stop-${resetKey(pause)}-${projectOf(root)}`))) return
  for (const argv of stopCommandsFor(root)) {
    await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)
  }
}

async function wrapUp($: EngineInterface, pause: Pause): Promise<void> {
  const resumeAt = localTime(pause.wakeAt)
  setStatus($, `Plan limit near: paused until ${resumeAt}`)
  await showCard($, `paused:${pause.resetsAt}`, pausedText(pause, localTime(pause.wakeAt)))
  const sessionId = await $.session.id()
  if (live.workSession !== sessionId) return notice($, nothingToSaveText(pause, resumeAt))
  const work = `work-${resetKey(pause)}-${sessionId}`
  await claim($, work)
  // Filed in the claim's folder (the helper made it): if this session is closed when the reset comes, a
  // later one in the project offers the work (adopt.tsx).
  const record = JSON.stringify(savedRecord(pause, sessionId, await $.session.root()), null, 2)
  await $.fs.write(`${await dataDir($)}/claims/${work}/${SAVED_FILE}`, record).catch(() => undefined)
  await notice($, savingText(pause, resumeAt))
  // Mid-turn, the wrap-up never starts beside the running turn: the turn is told to finish its
  // step, and turn.complete runs the wrap-up once it has ended.
  if (live.isTurnRunning) {
    live.pendingWrapUp = pause
    const text = finishStepText(pause)
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
    return
  }
  await startWrapUp($, pause)
}

// The wrap-up a turn that ended owed, unless the pause was cancelled or ended meanwhile. Another
// session may have extended it to a later reset: the same episode still owes this wrap-up.
async function runPendingWrapUp($: EngineInterface): Promise<void> {
  const pending = live.pendingWrapUp
  if (!pending) return
  live.pendingWrapUp = undefined
  const pause = await readPause($)
  if (pause?.status !== 'active' || resetKey(pause) !== resetKey(pending)) return
  await startWrapUp($, pause)
}

async function startWrapUp($: EngineInterface, pause: Pause): Promise<void> {
  const resumeAt = localTime(pause.wakeAt)
  live.compactAfterTurn = pause
  const close = closeCommand(await $.command.list().catch(() => []))
  if (close) {
    void $.command.run({ command: close, args: WRAP_UP_ARGS }).catch(() => undefined)
  } else {
    void $.prompt
      .submit({ text: `[usage-guard] ${WRAP_UP_ARGS} Work resumes automatically at ${resumeAt}.` })
      .catch(() => undefined)
  }
}

// Measured against the compaction window, as the context meter is; the model's whole window stands in
// when the engine reports none. The plain summary is estimated locally and costs nothing. The percent stays
// unrounded, so a fill just under the compaction setting never rounds up past it.
async function readFill($: EngineInterface): Promise<Fill | undefined> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const size = context.breakdown?.rawMaxTokens ?? context.window
    if (context.tokens === undefined || !size) return undefined
    return { tokens: context.tokens, percent: (context.tokens / size) * 100 }
  } catch {
    return undefined
  }
}

// Never from a command or a turn's own hook, which the engine refuses: always from a timer after it. The
// engine also refuses while a turn runs; that refusal, like a hook's veto, is reported. How it went is a
// note in the transcript, and /usage-guard repeats it, since a note may not reach every surface.
async function compactNow($: EngineInterface, pausedUntil?: string): Promise<CompactOutcome> {
  const before = (await readFill($))?.tokens
  let outcome: CompactOutcome
  try {
    outcome = outcomeOf(await $.session.compact({ instructions: PAUSE_INSTRUCTIONS }), before)
  } catch (err) {
    outcome = { kind: 'not-run', reason: err instanceof Error ? err.message : String(err) }
  }
  live.measuring = outcome.kind === 'measuring' ? { before: outcome.before, pausedUntil } : undefined
  await reportCompaction($, outcome)
  return outcome
}

async function reportCompaction($: EngineInterface, outcome: CompactOutcome): Promise<void> {
  live.lastCompaction = `${localTime(await $.clock.now())}: ${outcomeText(outcome)}`
  await notice($, outcomeText(outcome))
}

// The first reply after a compaction carries its real size: only then is it called freed or not.
async function measureCompaction($: EngineInterface): Promise<void> {
  const pending = live.measuring
  const after = pending && (await readFill($))?.tokens
  if (!pending || after === undefined) return
  live.measuring = undefined
  if (pending.before === undefined) return
  const outcome = measured(pending.before, after)
  await reportCompaction($, outcome)
  if (pending.pausedUntil && live.isStatusShown)
    setStatus($, `Plan limit near: paused until ${pending.pausedUntil} · ${outcomeMark(outcome)}`)
}

// Compacts while the cache is warm, so the wake starts from the summary. A pause's compaction runs only when
// the setting and the time to the wake say it is worth it; one the arm tool was asked for always runs.
async function compactOwed($: EngineInterface, owed: Pause | undefined, isAsked: boolean): Promise<void> {
  const found = owed && (await readPause($))
  const pause = owed && found?.status === 'active' && resetKey(found) === resetKey(owed) ? found : undefined
  const now = await $.clock.now()
  const isWorth = pause && shouldCompactAtPause(await readFill($), live.compactAbovePercent, pause.wakeAt, now)
  if (!isAsked && !isWorth) return
  const outcome = await compactNow($, pause && localTime(pause.wakeAt))
  if (pause) setStatus($, `Plan limit near: paused until ${localTime(pause.wakeAt)} · ${outcomeMark(outcome)}`)
}

// Taken before the turn's own wrap-up starts, so a wrap-up started at this turn's end waits for its own.
function scheduleOwedCompaction($: EngineInterface): void {
  const owed = live.compactAfterTurn
  const isArmOwed = live.isArmCompactOwed === true
  live.compactAfterTurn = undefined
  live.isArmCompactOwed = false
  const run = owed || isArmOwed ? () => compactOwed($, owed, isArmOwed) : undefined
  if (run) $.clock.after(COMPACT_DELAY_MS, () => void run().catch(() => undefined))
}

async function resume($: EngineInterface, resetsAt: string, isArmed = false): Promise<void> {
  // Read first: an arm for this reset counts even if its own timer clears it while this one runs.
  const held = await read($, armedWake)
  const isArmedHere = isArmed || held?.resetsAt === resetsAt
  const pause = await readPause($)
  if (!pause || pause.resetsAt !== resetsAt || pause.status === 'cancelled') return
  // Each session resumes once per reset, even when an instance left by a hot reload still runs its own
  // timer beside this one. The shared `done` status cannot be the claim: every session resumes.
  const won = await tryClaim($, `resume-${resetKey(pause)}-${await $.session.id()}`)
  if (won === false) return
  if (pause.status === 'active') await writePause($, { ...pause, status: 'done' })
  setStatus($, undefined)
  await showCard($, `reset:${resetsAt}`, 'Plan limits have reset. Sessions are resuming their saved work.')
  // Fails closed: with no resume claim on disk, an instance a hot reload left beside this one could
  // win it too, and find the work claim this one's question made.
  if (won === null) return notice($, UNCONFIRMED_NOTICE)
  // Only a session that saved work, or one armed, goes on by itself. Another session in the project
  // would rebuild the same hand-off and work the same tasks beside it, with nobody watching either.
  const work = await hadWork($, pause)
  const text = 'Plan limits have reset: resuming the saved work.'
  const reason = isArmedHere ? held?.reason : undefined
  if (work === true) return resumeWork($, text, reason)
  if (isArmedHere) return resumeArmed($, `after the ${limitName(pause)} reset`, text, held?.armedIn, reason)
  if (work === null) return notice($, UNCONFIRMED_NOTICE)
  // Worded as what is on record, not what happened: a wrap-up whose own claim failed before a hot
  // reload, or one before a /clear, saved work that left no claim under this session's id.
  return notice($, NO_WORK_NOTICE)
}

// An armed session goes on with its work, or, with nothing pending, only says so: the person asked for
// the wake-up, and a full resume would rebuild a hand-off for no work. A reason is work of its own. A
// /clear starts an empty task list, so the list of the session the arm was set in counts too. Callers
// pass both: the arm may be gone.
async function resumeArmed($: EngineInterface, armedFor: string, text: string, armedIn?: string, reason?: string) {
  const isPending = (await openTasks($)) !== 0 || (armedIn !== undefined && (await openTasks($, armedIn)) !== 0)
  if (reason || isPending) return resumeWork($, text, reason)
  await notice($, quietResumeText(armedFor))
  void $.prompt.submit({ text: quietResumePrompt(armedFor) }).catch(() => undefined)
}

// A wrap-up with work leaves a claim (this instance remembers it as handled, another finds it taken).
// Asking makes the claim for a session without one, which is harmless: only a session whose resume
// claim is on disk asks, so no other instance gets this far for it.
// Unknown (null) when the helper fails: a session told it saved nothing would never be resumed by hand.
async function hadWork($: EngineInterface, pause: Pause): Promise<boolean | null> {
  const name = `work-${resetKey(pause)}-${await $.session.id()}`
  if (live.handled.has(name)) return true
  const won = await tryClaim($, name)
  return won === null ? null : !won
}

// Never the project's /start-session: a ritual that proposes a plan and waits for an OK would wake the
// session only to stop it again. The engine runs a plugin's prompt once the session is idle, so a
// person typing meanwhile is never cut off.
async function resumeWork($: EngineInterface, text: string, reason?: string): Promise<void> {
  const said = reason ? `${text} ${reasonText(reason)}` : text
  await notice($, said)
  void $.prompt.submit({ text: resumePrompt(said) }).catch(() => undefined)
}

// The pause arms this session for its wake (pausearm.ts), so a disarm here cancels this session's resume alone.
// Saved work is read from disk too: a hot reload or a restart starts the module over with no memory of the wrap-up.
async function armPause($: EngineInterface, pause: Pause): Promise<void> {
  const me = await $.session.id()
  const savedAt = `${await dataDir($)}/claims/work-${resetKey(pause)}-${me}/${SAVED_FILE}`
  const isSaved = async () => parseSaved(String(await $.fs.read(savedAt).catch(() => ''))) !== undefined
  const hasWork = live.workSession === me || (await isSaved())
  await armForPause($, pause, hasWork, resetsAt => resume($, resetsAt))
}

async function scheduleArm($: EngineInterface, arm: ArmedWake): Promise<void> {
  live.armTimer?.cancel()
  const wait = Math.max(0, arm.wakeAt - (await $.clock.now()))
  live.armTimer = $.clock.after(wait, () => {
    live.armTimer = undefined
    void wakeArmed($, arm).catch(() => undefined)
  })
}

// An armed wake that came due: this session resumes, unless the arm was dropped or replaced, or a
// pause owns the resume. A pause still on (another session may have extended it past this reset)
// would be worked through, so the arm moves to the pause's own wake: there it stands down if the
// pause resumes the session, and still fires if another session cancelled the pause meanwhile. A
// pause for this same reset resumes through the pause path: its claim makes that a no-op when this
// session's own pause wake already resumed it, and still resumes a session that never saw the pause.
async function wakeArmed($: EngineInterface, arm: ArmedWake): Promise<void> {
  const current = await read($, armedWake)
  if (current?.resetsAt !== arm.resetsAt || current.kind !== arm.kind) {
    // The instance a hot reload left behind may have fired first and moved the arm, with the timer
    // for the new wake in that instance only: this one takes it up (the arm claim keeps one resume).
    // A command in this instance that re-armed or disarmed leaves a timer set or nothing to take.
    if (current && !live.armTimer) await scheduleArm($, current)
    return
  }
  if (await dropIfDisarmedByAll($)) return
  const pause = await readPause($)
  if (pause?.status === 'active' && pause.wakeAt > (await $.clock.now())) {
    // From the arm as it stands, not as this timer was set: its question, its sessions are kept.
    const later: ArmedWake = { ...current, resetsAt: pause.resetsAt, wakeAt: pause.wakeAt }
    await setArm($, later)
    await scheduleArm($, later)
    return
  }
  // An instance left by a hot reload may fire the same arm beside this one: one wins the claim. With no
  // claim on disk the other could win it too, so a failed helper resumes nothing (fails closed).
  // Under the id the arm is filed under, the one an adopting session claims (a /clear may lag behind).
  const filedAs = current.session ?? (await $.session.id())
  const won = await tryClaim($, `arm-${Date.parse(arm.resetsAt)}-${filedAs}`)
  // Taken with the saved copy gone: another session adopted it, so nothing here runs it. Stand down.
  const copy = won === false && parseSavedArm(String(await $.fs.read(await armPath($, filedAs)).catch(() => '')))
  if (won === false) return void (copy ? undefined : await update($, armedWake, () => null))
  // The arm stays set until the resume has run, so the pause's own timer, firing beside this one, sees it.
  const isPauseReset = pause && pause.resetsAt === arm.resetsAt && pause.status !== 'cancelled'
  if (won === null) await notice($, UNCONFIRMED_NOTICE)
  else if (isPauseReset) await resume($, arm.resetsAt, true)
  else {
    const text = `The wake you armed, ${armFor(arm.kind)}, has come: resuming the saved work.`
    await resumeArmed($, armFor(arm.kind), text, current.armedIn, current.reason)
  }
  // Cleared only if still this arm: the person may have set another while the resume ran.
  const now = await read($, armedWake)
  if (now?.resetsAt === arm.resetsAt && now.kind === arm.kind) await setArm($, null)
}

// The open tasks in a session's list (this one's by default), from the tasks mod's copy: none when that
// mod keeps lists but none for the session. Undefined without the tasks mod, or when the list cannot be read.
async function openTasks($: EngineInterface, sessionId?: string): Promise<number | undefined> {
  const dir = (await dataDir($)).replace(/usage-guard$/, 'tasks')
  try {
    await $.fs.list(dir)
  } catch {
    return undefined
  }
  try {
    return countOpenTasks(String(await $.fs.read(`${dir}/${sessionId ?? (await $.session.id())}.json`)))
  } catch {
    return 0
  }
}

// An arm with nothing pending and no reason is still set, since the person asked for it, but says so and
// asks: a card above the prompt where there is one, and the answer itself names the command for a surface
// without it. The answer gives the full date and how far off it is, so a wrong time shows at once.
// `compact`: the person asked for it, so it runs whatever the context's size or the time to the wake. From
// the tool (`isMidTurn`), it waits for the turn to end, since the engine refuses one while a turn runs.
async function armByHand($: EngineInterface, request: ArmRequest | string, isMidTurn = false): Promise<string> {
  if (typeof request === 'string') return request
  // Read again: the zone may have changed (daylight saving) since this module loaded.
  await readZone($)
  const now = await $.clock.now()
  const planned = planWake(request, (await $.session.usage()).rateLimits, live.delayMinutes, now, live.zone)
  if (typeof planned === 'string') return planned
  const earlier = await read($, armedWake)
  const isEmpty = !planned.reason && (await openTasks($)) === 0
  const asked = isEmpty ? { isQuestioned: true } : {}
  const arm: ArmedWake = { ...planned, armedIn: await $.session.id(), setAt: now, ...asked }
  await setArm($, arm)
  await scheduleArm($, arm)
  const lines = [armedText(arm, localTime(arm.wakeAt), untilText(arm.wakeAt, now))]
  if (earlier && earlier.wakeAt !== arm.wakeAt) lines.push(`It replaces the wake set for ${localTime(earlier.wakeAt)}.`)
  if (isEmpty) lines.push(EMPTY_ARM_NOTE)
  if (request.isCompact && isMidTurn) {
    live.isArmCompactOwed = true
    lines.push('Compacting this session once this turn ends; /usage-guard then says how it went.')
  } else if (request.isCompact) {
    $.clock.after(COMPACT_DELAY_MS, () => void compactNow($).catch(() => undefined))
    lines.push('Compacting this session in a moment; /usage-guard then says how it went.')
  }
  return lines.join('\n')
}

// The card's Keep: the arm stands, and the question goes.
// A press always answers: the card turns into a one-line confirmation, and the same line is a note in
// the transcript for a surface that draws no card.
async function keepArm($: EngineInterface): Promise<void> {
  const current = await read($, armedWake)
  if (!current?.isQuestioned) return
  await setArm($, { ...current, isQuestioned: false })
  await confirmPress($, `Kept: this session resumes at ${localTime(current.wakeAt)}.`)
}

async function cancelFromArmCard($: EngineInterface): Promise<void> {
  await confirmPress($, await disarm($))
}

async function confirmPress($: EngineInterface, text: string): Promise<void> {
  await update($, armNote, () => text)
  await notice($, text)
}

// Drops this session's arms, the one set by hand and its resume at a pause's wake: then it does not resume on its
// own. Other sessions keep theirs. The declined resume, saved, keeps the work it saved for the pause from being
// offered to another session, and leaves the resume to an arm set by hand later.
async function disarm($: EngineInterface): Promise<string> {
  const current = await read($, armedWake)
  live.armTimer?.cancel()
  live.armTimer = undefined
  await setArm($, null)
  const declined = await declinePauseArm($)
  return current || declined ? 'Disarmed: this session will not resume on its own.' : 'Nothing was armed.'
}

// This session's part in a live pause: it wraps up once and is armed for the wake. A session that met the pause
// before a hot reload or a restart, or under an earlier version, is armed again here; one that cancelled its
// resume stays cancelled (pausearm.ts).
async function act($: EngineInterface, pause: Pause): Promise<void> {
  if (await claim($, `${resetKey(pause)}-${await $.session.id()}`)) {
    await armPause($, pause)
    await stopBackground($, pause)
    await wrapUp($, pause)
  } else await armPause($, pause)
}

// A plan that reset before the pause's wake (a banked reset, for one) brings the wake to now for every session:
// an active pause resumes them, a cancelled one stays cancelled and only stops holding. A failed read is no reset.
async function endIfResetEarly($: EngineInterface, pause: Pause, now: number): Promise<Pause> {
  const { rateLimits } = await $.session.usage().catch(() => ({ rateLimits: [] }))
  if (!isResetEarly(pause, rateLimits, live.wrapUpAt, now)) return pause
  const current = await readPause($)
  const forward = bringForward(pause, current, now)
  if (!forward) return current ?? pause
  await writePause($, forward)
  await writeFence($, fenceAfter(await readFence($), forward))
  return forward
}

const HELD_BY_PAUSE = 'A pause still holds, so every arm keeps its time: lift it once the pause ends.'

async function isPauseHolding($: EngineInterface): Promise<boolean> {
  const pause = await readPause($)
  return pause?.status === 'active' && pause.wakeAt > (await $.clock.now())
}

// An arm set by hand wakes now: the card's "Lift it here", `/usage-guard lift`, or a lift of every session.
async function liftHere($: EngineInterface): Promise<string> {
  if (await isPauseHolding($)) return HELD_BY_PAUSE
  await clearSwitchCard($)
  const arm = await read($, armedWake)
  if (!arm) return 'No resume set by hand here to lift.'
  const moved = { ...arm, isQuestioned: false, wakeAt: await $.clock.now() }
  await setArm($, moved)
  await scheduleArm($, moved)
  return 'Lifted: this session resumes now.'
}

async function liftAll($: EngineInterface): Promise<string> {
  if (await isPauseHolding($)) return HELD_BY_PAUSE
  await writeMark($, 'lift', await $.clock.now())
  await liftHere($)
  return 'Lifting every resume set by hand: each session resumes at its next check, within a minute.'
}

// A switch to another account resets no window: a session with an arm set by hand waits for the person to lift it.
// The arm moves onto the pause's reset and keeps its own time, so its wake, or a lift, resumes the saved work too.
async function holdForLift($: EngineInterface, held: ArmedWake, pause: Pause): Promise<void> {
  const onPause = { ...held, resetsAt: pause.resetsAt }
  await setArm($, onPause)
  await scheduleArm($, onPause)
  await raiseSwitchCard($, onPause.wakeAt)
}

// A wake brought forward (another session saw the early reset) resumes this session now, if the pause still holds
// its resume. An arm already due, or already moved onto this pause, stands down as at the pause's own wake: brought
// to now on this reset, resume() counts it and its own timer then clears it. An arm still ahead keeps its own time.
async function resumeEarly($: EngineInterface, pause: Pause, now: number): Promise<void> {
  if (!(await takePauseArm($, pause))) return
  const held = await read($, armedWake)
  if (pause.isAccountLift && held) return holdForLift($, held, pause)
  const isStandingDown = held && (held.wakeAt <= now || held.resetsAt === pause.resetsAt)
  const moved = isStandingDown && { ...held, resetsAt: pause.resetsAt, wakeAt: pause.wakeAt }
  if (moved) await setArm($, moved).then(() => scheduleArm($, moved))
  return resume($, pause.resetsAt)
}

async function check($: EngineInterface): Promise<void> {
  await readSettings($)
  await dropIfDisarmedByAll($)
  const now = await $.clock.now()
  const sessionId = await $.session.id()
  // This session's readings belong to the account signed in once a turn of its own ended under that login.
  const login = await seeLogin($, now)
  await meetSwitch($, login)
  let pause = await readPause($)
  // Another account's windows reset at their own times, which is no early reset of the paused ones.
  const isSameAccount = !pause?.account || !login.account || pause.account === login.account.id
  if (pause && isSameAccount) pause = await endIfResetEarly($, pause, now)
  if (pause) pause = await endIfSwitched($, pause, login)
  if (pause && pause.status !== 'cancelled' && pause.wakeAt <= now) await resumeEarly($, pause, now)
  if (await isLiftAsked($, pause, now)) await liftHere($)
  const isLive = pause?.status === 'active' && pause.wakeAt > now

  if (!isLive) {
    // Readings from before a switch, of another account, never plan a pause.
    if (!login.isFresh) return
    const { rateLimits } = await $.session.usage()
    const fresh = unfenced(rateLimits, await readFence($))
    const hot = hotLimits(fresh, live.wrapUpAt).filter(limit => Date.parse(limit.resetsAt ?? '') > now)
    if (hot.length === 0) return
    const onAccount = login.account ? { account: login.account.id } : {}
    // Back on an account whose pause a switch ended: that pause's claims are spent, so this one is a new episode.
    const anew = pause?.isAccountLift ? { episode: new Date(now).toISOString() } : {}
    const planned = { ...planPause(hot, live.delayMinutes, sessionId), ...onAccount, ...anew }
    // One pause per reset: a cancelled or finished one is not re-armed by the same high reading, nor by a
    // stale one for a reset it was extended past.
    if (covers(pause, planned)) return
    pause = planned
    // Of several sessions crossing the line together, one writes the pause. The others write the same pause
    // only if the winner has not yet, so a cancel written in between is not undone.
    await claim($, `pause-${resetKey(planned)}`)
    // Read again after the claim: another session may have paused for a different reset meanwhile.
    const shared = await readPause($)
    const isSharedLive = shared?.status === 'active' && shared.wakeAt > now
    if (isSharedLive) {
      pause = joinPause(shared, planned)
      if (pause !== shared) await writePause($, pause)
    } else if (!covers(shared, planned)) {
      await writePause($, pause)
    } else return // A cancel written since the winner's pause, or since it was extended, is honoured.
  }
  if (pause) await act($, pause)
}

// The settings file, for what runs before any prompt (a start, a reload) and each check: see settings.tsx.
async function readSettings($: EngineInterface): Promise<void> {
  const file = await $.fs.read(`${await dataDir($)}/settings.json`).catch(() => '')
  const manifest = (dir: string) => $.fs.read(`${$.plugin.root}${dir}/plugin.json`)
  applyFile(String(file), String(await manifest('/.claude-plugin').catch(() => manifest('').catch(() => ''))))
}

// The time zone and the two timers (pause check, shared card refresh), once per module load. Every caller
// waits for the one start: a command that lands mid-start (a reload's) sees the arm it restores.
const startTimers = ($: EngineInterface): Promise<void> => (live.started ??= startOnce($).catch(() => undefined))
async function startOnce($: EngineInterface): Promise<void> {
  await readSettings($)
  await readZone($)
  await refresh($)
  const pause = await readPause($)
  if (pause?.status === 'active' && pause.wakeAt > (await $.clock.now())) await act($, pause)
  // A wake armed before a hot reload: the module's timer went with the old instance. Before a restart:
  // the state went with the process, and the saved arm stands in.
  const arm = (await read($, armedWake)) ?? (await restoreArm($))
  if (arm) await scheduleArm($, arm)
  $.clock.every(CHECK_EVERY_MS, () => void followSession($).then(() => check($)).catch(() => undefined))
  $.clock.every(REFRESH_MS, () => void refresh($).catch(() => undefined))
}

// A session that starts during a pause: it has nothing to save yet, so it only waits for the reset.
// One that starts after the reset is told to resume by hand.
async function meetPause($: EngineInterface, pause: Pause): Promise<void> {
  if (pause.wakeAt <= (await $.clock.now())) {
    await writePause($, { ...pause, status: 'done' })
    const text = 'Plan limits have reset since the last wrap-up. Run /start-session (or /session-start) to resume.'
    await showCard($, `missed:${pause.resetsAt}`, text)
    await notice($, text)
    return
  }
  await claim($, `${resetKey(pause)}-${await $.session.id()}`)
  await armPause($, pause)
  // A project no session had open when the pause began still has its background work stopped.
  await stopBackground($, pause)
  setStatus($, `Plan limit near: paused until ${localTime(pause.wakeAt)}`)
  await showCard($, `paused:${pause.resetsAt}`, pausedText(pause, localTime(pause.wakeAt)))
  await notice($, joinedPauseText(pause, localTime(pause.wakeAt)))
}

// What shows above the prompt: the shared card every session draws (pause, resume, cancel), then this
// session's own question about an arm set with nothing pending.
async function cardsAbove($: EngineInterface): Promise<Card[]> {
  const cards: Card[] = []
  const shown = await read($, band)
  if (shown?.card) {
    const buttons: CardButton[] = [
      { key: 'usage-dismiss', label: 'Dismiss', isPrimary: true, onPress: () => dismissCard($) },
    ]
    if (shown.canCancel && shown.canDisarmHere) {
      const label = 'Cancel resume (this session)'
      buttons.push({ key: 'usage-disarm-here', label, onPress: async () => confirmPress($, await disarm($)) })
    }
    if (shown.canCancel) {
      const label = 'Cancel resume (all sessions)'
      buttons.push({ key: 'usage-cancel', label, onPress: () => disarmGlobal($) })
    }
    cards.push({ key: 'usage-card', tone: cardTone(shown.card.id), text: shown.card.text, buttons })
  }
  const arm = await read($, armedWake)
  if (arm?.isQuestioned) {
    const text = questionText(localTime(arm.wakeAt))
    const buttons: CardButton[] = [
      { key: 'usage-arm-keep', label: 'Keep it', isPrimary: true, onPress: () => keepArm($) },
      { key: 'usage-arm-cancel', label: 'Cancel the resume', onPress: () => cancelFromArmCard($) },
    ]
    cards.push({ key: 'usage-arm-question', tone: 'yellow', text, buttons })
  }
  const switched = (await read($, accountView))?.card
  // Only while the arm it was raised for stands: a wake, a disarm or a new arm ends what it says.
  if (switched && arm && arm.wakeAt === switched.wakeAt) {
    const dismiss = () => clearSwitchCard($)
    const buttons: CardButton[] = [
      { key: 'usage-switch-dismiss', label: 'Dismiss', isPrimary: true, onPress: dismiss },
      { key: 'usage-lift-here', label: 'Lift it here', onPress: async () => confirmPress($, await liftHere($)) },
      { key: 'usage-lift-all', label: 'Lift in every session', onPress: async () => confirmPress($, await liftAll($)) },
    ]
    const text = switchCardText(switched.label, localTime(arm.wakeAt))
    cards.push({ key: 'usage-switch', tone: 'yellow', text, buttons })
  }
  const note = await read($, armNote)
  if (note) {
    const clear = () => update($, armNote, () => null)
    const dismiss = { key: 'usage-arm-note-dismiss', label: 'Dismiss', isPrimary: true, onPress: clear }
    cards.push({ key: 'usage-arm-note', tone: 'blue', text: note, buttons: [dismiss] })
  }
  return cards
}

// The slim line while an arm stands, so a scheduled wake is never out of sight. It gives way to the arm's
// own question and to the shared pause card, which already say when the session resumes.
async function armLine($: EngineInterface): Promise<string | undefined> {
  const arm = await read($, armedWake)
  if (!arm || arm.isQuestioned || (await read($, band))?.card) return undefined
  const limits = await $.session.usage().then(usage => usage.rateLimits, () => [])
  return armLineText(arm, live.zone, limits)
}

export const register: Register = (on, options) => {
  // The settings come from the mod's own file over the loaded options, read again as it changes.
  settings(on, options, values => applyValues(live, values))
  // Outside phone, so its command reads the offer the adopt module just looked for.
  adopt(on, options)
  phone(on, options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await readZone($)
    const pause = await readPause($)
    if (pause?.status === 'active') await meetPause($, pause)
    // The timers (and with them a saved arm) first: a refused command must never cost the arm's wake,
    // and a start after a reload may find /usage-guard already registered.
    await startTimers($)
    const command = { name: 'usage-guard', description: COMMAND_TEXT, argumentHint: ARGUMENT_HINT }
    await $.command.register(command).catch(() => undefined)
    await $.tool.register(ARM_TOOL).catch(() => undefined)
    return result
  })

  // The cards, drawn above whatever the other mods draw there, each staying until it is answered or
  // dismissed; then, under those mods' rows, the slim line of a standing arm.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inner = await next(e)
    if (e.props.hasSurvey) return inner
    const cards = await cardsAbove($)
    const line = await armLine($)
    if (cards.length === 0 && !line) return inner
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const width = Math.max(30, Math.min(64, e.props.bodyColumns - 2))
    return (
      <Box flexDirection="column">
        {drawCards(ui, cards, width)}
        {inner}
        {line ? drawArmLine(ui, line, () => cancelFromArmCard($)) : null}
      </Box>
    )
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's turn (2.1.299+) has no main turn.complete after it, so it never marks a turn running.
    if ((e as { agentId?: string }).agentId === undefined) live.isTurnRunning = true
    // A hot reload starts the module over without a session.start: the first turn after it restarts
    // the timers and reads the time zone again.
    await startTimers($).catch(() => undefined)
    await followSession($).catch(() => undefined)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await followSession($, e.session_id).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Core marks a call read-only (true) or leaves the flag out, never false: any answered call without the
    // mark may have changed something. Setting an arm changes no work.
    const isWork = !result.deny && !result.isError && result.isReadOnly !== true && !ARM_TOOL_NAME.test(e.tool)
    if (isWork) live.workSession = await $.session.id()
    return result
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends inside main's or after it: main's turn is not over.
    if (e.agentId !== undefined) return next(e)
    live.isTurnRunning = false
    const result = await next(e)
    // Taken before anything below can start a wrap-up: a compaction owed by one runs after its own turn.
    scheduleOwedCompaction($)
    // A reload in the middle of a turn: the turn's start ran in the module before it, so its end restarts
    // the timers, or a saved arm would wait idle past its wake.
    await startTimers($).catch(() => undefined)
    await measureCompaction($).catch(() => undefined)
    await runPendingWrapUp($).catch(() => undefined)
    await noteReading($).catch(() => undefined)
    await check($).catch(() => undefined)
    return result
  })

  // A hot reload while idle leaves no turn to restart the timers: the command does, so its answer (and a
  // disarm) sees the arm restored from its saved copy, and the arm's timer runs again.
  on('command.run', { command: 'usage-guard' }, async ($, e) => {
    await startTimers($).catch(() => undefined)
    return { text: await runCommand($, e.args) }
  })

  // The same arm for Claude, asked for a wake-up. A pattern, as the generated tool names list only the
  // tools already live on the machine that wrote them.
  on('tool.call', { tool: ARM_TOOL_NAME }, async ($, e) => {
    await startTimers($).catch(() => undefined)
    const input = e as { at?: unknown; reason?: unknown; compact?: unknown }
    return { result: await armByHand($, toolRequest(input), true) }
  })
}

// `/usage-guard [help | settings | arm ... | disarm | disarm-global | lift | lift-all]`; with no argument, the status.
async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = ''] = args.trim().split(/\s+/)
  if (verb === 'help') return HELP
  if (verb === 'settings') {
    await $.ui.open({ id: SETTINGS_PANE, title: 'Usage guard settings', focus: true })
    return 'Opened the usage-guard settings.'
  }
  if (verb === 'arm') return armByHand($, parseArmArgs(args.trim().slice(verb.length)))
  if (verb === 'disarm') return disarm($)
  // `cancel` is the earlier name of disarm-global, kept so a habit or a script still works.
  if (verb === 'disarm-global' || verb === 'cancel') return disarmGlobal($)
  if (verb === 'lift') return liftHere($)
  if (verb === 'lift-all') return liftAll($)
  const pause = await readPause($)
  const armAt = (await read($, armedWake))?.wakeAt
  return statusText({ pause, armAt, lastCompaction: live.lastCompaction, wrapUpAt: live.wrapUpAt, zone: live.zone })
}

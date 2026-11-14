import type { EngineInterface, Register } from 'claude-code'

import {
  hasEngineWake, hasPendingWake, isNearCompaction, isPauseHolding, keepGoingText, MAX_IDLE_PROMPTS,
  nearCompactionText, workable,
} from './keepgoing'
import { applyFile, register as settings, SETTINGS_PANE } from './settings'
import { PANE, phoneText } from './view'
import type { EngineTask, Mirror, TaskArgs } from './mirror'
import {
  ALIVE_EVERY_MS,
  answerTool,
  carriedText,
  importEngineTasks,
  nudgeText,
  openListText,
  openTasks,
  overlapText,
  pickPredecessor,
  staleText,
} from './mirror'

// This mod is the main session's task list: it answers TaskCreate, TaskUpdate,
// TaskList and TaskGet itself from `mods-data/tasks/<session>.json`, so the
// engine's own store (deleted once every task is completed) and its panel under
// the spinner (forced open on every task change) never come into play; the
// mod's band is the one list on screen. Subagents keep the engine's tools. It
// also allows one task in progress at a time, names stale tasks instead of the
// engine's generic reminder, and asks for a list when a turn grows without one.

export const HOLD_HELP =
  'To put a task ON HOLD while it waits on a decision or another task, set status "pending" and ' +
  'metadata {"hold": "<what it waits on>"}; clear it with metadata {"hold": null} (starting or ' +
  'completing the task clears it too).'

const KEEP_TASKS = 50
const COMMAND = 'task-list'
const HINT = '[help | settings | set | phone]'
export const HELP = [
  '/task-list: keeps the task list honest and shows it in the band above the prompt.',
  '  /task-list           open the task list',
  '  /task-list settings  open the settings pane',
  '  /task-list set       change a setting: set <name> <value>; alone, list them',
  '  /task-list phone     the same as text, for phone chats',
  '  /task-list help      this list',
].join('\n')
const SWEEP_DAYS = 14
// A list with nothing left to carry over (handed over, or no open task) goes sooner.
const DONE_SWEEP_DAYS = 7
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const UNCOUNTED_TOOLS = new Set([...TASK_TOOLS, 'ToolSearch', 'TaskStop', 'TaskOutput', 'SendMessage'])
const UNLINK_SCRIPT =
  'const fs=require("fs"),p=require("path");const [d,...names]=process.argv.slice(1);' +
  'for(const n of names){try{fs.unlinkSync(p.join(d,n))}catch{}}'
// Other sessions' lists and alive stamps not written for SWEEP_DAYS go (a done list after DONE_SWEEP_DAYS),
// never the settings; a session resumed after SWEEP_DAYS keeps its own list (`node <plugin root>/
// scripts/sweep.cjs <folder> <this session's id> <days> <doneDays>`; test-helper/sweep.spec.cjs runs it).
export const SWEEP_SCRIPT = 'scripts/sweep.cjs'

const live: {
  mirror?: Mirror
  turn: number
  isTurnRunning: boolean
  toolsThisTurn: number
  sawTaskTool: boolean
  isNudged: boolean
  // Set when a task was started; checked at the next non-task tool call, so a batch that
  // finishes one task and starts the next settles before overlap is judged.
  checkOverlap: boolean
  afterCompact: boolean
  isEngineCleared: boolean
  isAliveStarted: boolean
  nudgeAfter: number
  keepGoing: boolean
  // Keep-going prompts sent in a row with no change to the list, and the list's changedAt at the last one.
  idlePrompts: number
  promptedAt?: number
  // The last turn's end left background work or a scheduled wake that will wake the session (Stop event).
  hasEngineWake: boolean
  // The session the carry-over last ran for: a /clear changes the session with no session.start.
  carriedFor?: string
} = {
  turn: 0,
  hasEngineWake: false,
  isTurnRunning: false,
  toolsThisTurn: 0,
  sawTaskTool: false,
  isNudged: false,
  checkOverlap: false,
  afterCompact: false,
  isEngineCleared: false,
  isAliveStarted: false,
  nudgeAfter: 3,
  keepGoing: true,
  idlePrompts: 0,
}

// The engine's fs makes no missing folders, so the data folder is made through node, once per load.
export const MKDIR_SCRIPT = 'require("fs").mkdirSync(process.argv[1],{recursive:true})'
const madeDirs = new Set<string>()
async function ensureDir($: EngineInterface, dir: string): Promise<void> {
  if (madeDirs.has(dir)) return
  const { exitCode } = await $.process.run(['node', '-e', MKDIR_SCRIPT, dir], { timeoutMs: 10_000 })
  if (exitCode === 0) madeDirs.add(dir)
}

async function dataDir($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${configured ?? `${home}/.claude`}/mods-data/tasks`.replaceAll('\\', '/')
}

async function mirrorOf($: EngineInterface): Promise<Mirror> {
  if (live.mirror) return live.mirror
  const session = await $.session.id()
  try {
    live.mirror = JSON.parse(String(await $.fs.read(`${await dataDir($)}/${session}.json`))) as Mirror
    live.turn = Math.max(live.turn, live.mirror.turn)
  } catch {
    live.mirror = { session, updatedAt: 0, turn: live.turn, tasks: [] }
  }
  live.mirror.root = (await $.session.root()).replaceAll('\\', '/').toLowerCase()
  return live.mirror
}

// True when the mirror file was written.
async function saveMirror($: EngineInterface, mirror: Mirror): Promise<boolean> {
  // A session writing its own list makes it current again: a resumed session's new leftovers carry over.
  delete mirror.handedOverAt
  mirror.updatedAt = await $.clock.now()
  mirror.turn = live.turn
  mirror.tasks.sort((a, b) => Number(a.id) - Number(b.id))
  if (mirror.tasks.length > KEEP_TASKS) {
    // Drop the oldest finished tasks first; open ones always stay.
    const finished = mirror.tasks.filter(task => task.status === 'completed')
    const drop = new Set(finished.slice(0, mirror.tasks.length - KEEP_TASKS).map(task => task.id))
    mirror.tasks = mirror.tasks.filter(task => !drop.has(task.id))
  }
  const dir = await dataDir($)
  await ensureDir($, dir).catch(() => undefined)
  return $.fs.write(`${dir}/${mirror.session}.json`, JSON.stringify(mirror, null, 1)).then(
    () => true,
    () => false,
  )
}

function withContext<T extends object>(result: T, note: string | undefined): T {
  if (!note || 'deny' in result) return result
  const before = (result as { context?: readonly string[] }).context ?? []
  return { ...result, context: [...before, note] }
}

// The engine's panel under the spinner draws the task files in the engine's store. The mod answers
// the task tools itself, so files there are leftovers from before it did: import what the list lacks,
// then delete them, which leaves the panel empty (it hides). Runs at a session start only.
// A subagent's task calls still go to the engine and land in this same folder (only a team gets its
// own), numbered from 1 like the mirror's, and a background subagent can outlive a turn; nothing in a
// file tells whose it is. None survives a restart, so a start imports and deletes everything. A hot
// reload deletes nothing: a subagent may be live then, and leftovers wait for the next start.
async function clearEngineStore($: EngineInterface): Promise<void> {
  if (live.isEngineCleared) return
  live.isEngineCleared = true
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const dir = `${configured ?? `${home}/.claude`}/tasks/${await $.session.id()}`.replaceAll('\\', '/')
  let names: string[]
  try {
    names = (await $.fs.list(dir)).map(entry => entry.name).filter(name => /^\d+\.json$/.test(name))
  } catch {
    return
  }
  if (names.length === 0) return
  const found = new Map<string, EngineTask>()
  for (const name of names) {
    try {
      found.set(name, JSON.parse(String(await $.fs.read(`${dir}/${name}`))) as EngineTask)
    } catch {
      // A half-written file is deleted with the rest.
    }
  }
  const mirror = await mirrorOf($)
  const now = await $.clock.now()
  if (importEngineTasks(mirror, [...found.values()], live.turn, now)) {
    mirror.changedAt = now
    // The engine's files are deleted only once the mirror holding their copy is written; until then
    // they wait for the next start.
    if (!(await saveMirror($, mirror))) return
  }
  await $.process.run(['node', '-e', UNLINK_SCRIPT, dir, ...names], { timeoutMs: 20_000 })
}

// Marks the finished list whose leftovers just reached the model, so no later session shows them again.
// Done when the note goes out, not at the start: a session that ends before its first prompt never saw
// them, and the next new session carries them instead. A list resumed and saved again after it was carried
// holds tasks this session never showed, so it stays unmarked for the next new session.
async function markHandedOver($: EngineInterface, carrier: Mirror): Promise<void> {
  if (!carrier.carriedFrom) return
  const path = `${await dataDir($)}/${carrier.carriedFrom}.json`
  const previous = JSON.parse(String(await $.fs.read(path))) as Mirror
  if (previous.updatedAt !== carrier.carriedUpdatedAt) return
  previous.handedOverAt = await $.clock.now()
  await $.fs.write(path, JSON.stringify(previous, null, 1))
}

async function carryOver($: EngineInterface): Promise<void> {
  const mirror = await mirrorOf($)
  if (mirror.tasks.length > 0 || mirror.carried) return
  const dir = await dataDir($)
  const mirrors: Mirror[] = []
  const aliveAt = new Map<string, number>()
  for (const entry of await $.fs.list(dir)) {
    try {
      const text = String(await $.fs.read(`${dir}/${entry.name}`))
      if (entry.name.endsWith('.json')) mirrors.push(JSON.parse(text) as Mirror)
      else if (entry.name.endsWith('.alive')) aliveAt.set(entry.name.slice(0, -'.alive'.length), Number(text))
    } catch {
      // A half-written or foreign file is skipped.
    }
  }
  const previous = pickPredecessor(mirrors, aliveAt, mirror.root ?? '', mirror.session, await $.clock.now())
  if (!previous) return
  const now = await $.clock.now()
  mirror.carried = openTasks(previous)
  mirror.carriedFrom = previous.session
  mirror.carriedUpdatedAt = previous.updatedAt
  mirror.changedAt = now
  await saveMirror($, mirror)
}

// The carry-over, once per session: at its start, or at the first prompt of a session a /clear began,
// by which time the session before it has marked its end.
async function carryOverOnce($: EngineInterface): Promise<void> {
  const session = await $.session.id()
  if (live.carriedFor === session) return
  live.carriedFor = session
  await carryOver($).catch(() => undefined)
}

// Writes only the stamp file, for the session id of the moment: a timer a hot reload left behind,
// or one still running after /clear, stamps the live session and never touches a task list.
async function stampAlive($: EngineInterface): Promise<void> {
  const dir = await dataDir($)
  await ensureDir($, dir).catch(() => undefined)
  await $.fs.write(`${dir}/${await $.session.id()}.alive`, String(await $.clock.now()))
}

// Stamps at once, and starts the minute timer once per load (a hot reload runs no session.start).
async function startAlive($: EngineInterface): Promise<void> {
  await stampAlive($).catch(() => undefined)
  if (live.isAliveStarted) return
  live.isAliveStarted = true
  $.clock.every(ALIVE_EVERY_MS, () => void stampAlive($).catch(() => undefined))
}

async function markEnded($: EngineInterface): Promise<void> {
  const mirror = await mirrorOf($)
  mirror.endedAt = await $.clock.now()
  if (mirror.tasks.length > 0 || mirror.carried) await saveMirror($, mirror)
}

const KEEP_GOING_DELAY_MS = 3_000

// The file another mod keeps beside this one's: `mods-data/<mod>/<name>`. Undefined when it is not there.
async function peerFile($: EngineInterface, mod: string, name: string): Promise<string | undefined> {
  const dir = (await dataDir($)).replace(/\/tasks$/, `/${mod}`)
  return $.fs.read(`${dir}/${name}`).then(String, () => undefined)
}

// Whether the person turned automatic compaction off: `DISABLE_AUTO_COMPACT` or `DISABLE_COMPACT`, or
// auto-compact off in /config (`autoCompactEnabled`, in the settings or the global config). An unreadable
// global config counts as off, since it may hold the switch.
async function isAutoCompactOff($: EngineInterface): Promise<boolean> {
  const isSet = (value: string | undefined) => Boolean(value) && !/^(0|false)$/i.test(value ?? '')
  if (isSet(await $.env.get('DISABLE_AUTO_COMPACT').catch(() => undefined))) return true
  if (isSet(await $.env.get('DISABLE_COMPACT').catch(() => undefined))) return true
  const settings = (await $.settings.read().catch(() => ({}))) as { autoCompactEnabled?: unknown }
  if (settings.autoCompactEnabled === false) return true
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const file = (configured ? `${configured}/.claude.json` : `${home}/.claude.json`).replace(/\\/g, '/')
  try {
    return (JSON.parse(String(await $.fs.read(file))) as { autoCompactEnabled?: unknown }).autoCompactEnabled === false
  } catch {
    return true
  }
}

// Whether a compaction is coming soon: the context near the auto-compaction point, with auto-compaction on.
// False when the engine cannot say.
async function isContextNearCompaction($: EngineInterface): Promise<boolean> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    if (!isNearCompaction(context.tokens, context.breakdown?.autoCompactThreshold)) return false
  } catch {
    return false
  }
  return !(await isAutoCompactOff($))
}

// A turn that ended with work nobody has to wait for gets a prompt to carry on, unless something else
// wakes the session (background work, a scheduled wake, a CI watch, a plan-limit pause) or the last prompts
// changed nothing on the list. Near the compaction a turn's end gets one even with no workable task: the
// next step it announced is the work.
async function keepGoing($: EngineInterface): Promise<void> {
  if (live.isTurnRunning) return
  const mirror = await mirrorOf($)
  const tasks = workable(mirror)
  if (live.hasEngineWake) return
  if (tasks.length === 0 && !(await isContextNearCompaction($))) return
  const ciWatch = await peerFile($, 'ci-watch', `${await $.session.id()}.json`)
  if (hasPendingWake(ciWatch, await $.clock.now())) return
  if (isPauseHolding(await peerFile($, 'usage-guard', 'pause.json'), await $.clock.now())) return
  const isIdle = live.idlePrompts > 0 && live.promptedAt === mirror.changedAt
  // With no task to name, one prompt: a turn that still ends after it waits on a person.
  if (isIdle && live.idlePrompts >= (tasks.length > 0 ? MAX_IDLE_PROMPTS : 1)) return
  live.idlePrompts = isIdle ? live.idlePrompts + 1 : 1
  live.promptedAt = mirror.changedAt
  await $.prompt.submit({ text: tasks.length > 0 ? keepGoingText(tasks) : nearCompactionText() })
}

// The settings file at the session's start, before any tool call: the settings module follows it from
// there. Read here, since an engine handle is never passed into another file.
async function readSettings($: EngineInterface): Promise<void> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const file = await $.fs.read(`${config}/mods-data/tasks/settings.json`.replace(/\\/g, '/')).catch(() => '')
  const manifest = (dir: string) => $.fs.read(`${$.plugin.root}${dir}/plugin.json`)
  applyFile(String(file), String(await manifest('/.claude-plugin').catch(() => manifest('').catch(() => ''))))
}

type On = Parameters<Register>[0]

// Registers the task command and the session's start and end.
function registerLifecycle(on: On): void {
  // `/task-list [help | settings]`; with no argument, the task list. Any other argument gets the help.
  // Not `/tasks`: that name is a built-in command, and the engine refuses it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    // Typed with no word over Remote Control (the phone, the web, Desktop viewing a CLI session), where no
    // row draws: the bare command answers with the phone text.
    const verb = e.args.trim() || (e.origin?.kind === 'bridge' ? 'phone' : '')
    if (verb === 'phone') return { text: `${phoneText((await mirrorOf($)).tasks)}\n/task-list help for more` }
    if (verb !== '' && verb !== 'settings') return { text: HELP }
    const [id, title] = verb === '' ? [PANE, 'Tasks'] : [SETTINGS_PANE, 'Tasks settings']
    await $.ui.open({ id, title, focus: true })
    return { text: verb === '' ? 'Opened the task list.' : 'Opened the tasks settings.' }
  })

  on('session.start', async ($, e, next) => {
    // A settings file that cannot be read never costs the start: the loaded options stand.
    await readSettings($).catch(() => undefined)
    const result = await next(e)
    // A refused command must never cost the rest of the start: the list, the carry-over, the band.
    await $.command
      .register({ name: COMMAND, description: 'The task list', argumentHint: HINT })
      .catch(() => undefined)
    const dir = await dataDir($)
    // Done before this session's list is read, so the two never race.
    const days = [String(SWEEP_DAYS), String(DONE_SWEEP_DAYS)]
    const sweep = ['node', `${$.plugin.root}/${SWEEP_SCRIPT}`, dir, await $.session.id(), ...days]
    await $.process.run(sweep, { timeoutMs: 20_000 }).catch(() => undefined)
    await clearEngineStore($).catch(() => undefined)
    await carryOverOnce($)
    await startAlive($)
    return result
  })

  // After a /clear the process goes on under a new session id with no session.start: the next save
  // reads that session's own mirror.
  on('session.end', async ($, e, next) => {
    await markEnded($).catch(() => undefined)
    live.mirror = undefined
    return next(e)
  })
}

// Registers the turn events and the compaction event.
function registerTurns(on: On): void {
  on('turn.start', async ($, e, next) => {
    await startAlive($)
    // A subagent's turn (2.1.299+) runs inside or after main's: it starts no new main turn.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    live.turn += 1
    live.isTurnRunning = true
    live.toolsThisTurn = 0
    live.sawTaskTool = false
    live.isNudged = false
    live.checkOverlap = false
    return next(e)
  })

  // The main session's turn end, with what the engine still has in flight to wake it. Read before the
  // keep-going look, which waits a moment after the turn completes.
  on('classic.Stop', async ($, e, next) => {
    live.hasEngineWake = hasEngineWake(e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends inside main's or after it: main's turn is not over.
    if (e.agentId !== undefined) return next(e)
    live.isTurnRunning = false
    // Looked at a moment after the turn ends, never from the end itself: a prompt sent there was seen lost.
    // `reason` is the engine's TurnCompleteReason ('answer' | 'aborted' | 'refusal' | 'error'): only a turn
    // the model answered goes on.
    if (live.keepGoing && e.reason === 'answer')
      $.clock.after(KEEP_GOING_DELAY_MS, () => void keepGoing($).catch(() => undefined))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    live.afterCompact = true
    return result
  })
}

// Registers the prompt hooks: the carry-over and stale notes, and the open-list reminder.
function registerPrompts(on: On): void {
  on('prompt.submit', async ($, e, next) => {
    // The person's own prompt, typed or from the phone: the keep-going count starts over.
    if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') live.idlePrompts = 0
    if (live.isTurnRunning) return next(e)
    await carryOverOnce($)
    const mirror = await mirrorOf($)
    const notes: string[] = []
    if (!mirror.isCarryNoted && mirror.carried?.length) {
      notes.push(carriedText(mirror.carried))
      mirror.isCarryNoted = true
      await saveMirror($, mirror)
      await markHandedOver($, mirror).catch(() => undefined)
    }
    const note = live.afterCompact ? openListText(mirror, live.turn) : staleText(mirror, live.turn)
    live.afterCompact = false
    if (note) notes.push(note)
    if (notes.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('prompt.attachment', { type: 'task_reminder' }, async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId) return answer
    return { text: openListText(await mirrorOf($), live.turn) }
  })
}

// Registers the task tools' answers, the tool-call checks and the hold description.
function registerTools(on: On): void {
  on('tool.call', async ($, e, next) => {
    if (TASK_TOOLS.has(e.tool) && !e.agentId) {
      live.sawTaskTool = true
      const mirror = await mirrorOf($)
      const now = await $.clock.now()
      const args = e as unknown as TaskArgs
      const before = JSON.stringify(mirror)
      const output = answerTool(mirror, e.tool, args, live.turn, now)
      if (e.tool === 'TaskUpdate' && args.status === 'in_progress' && (output as { success: boolean }).success) {
        live.checkOverlap = true
      }
      if (JSON.stringify(mirror) !== before) {
        mirror.changedAt = now
        await saveMirror($, mirror)
      }
      return { result: output } as never
    }
    const result = await next(e)
    if (e.agentId) return result
    if (!TASK_TOOLS.has(e.tool)) {
      if (UNCOUNTED_TOOLS.has(e.tool)) return result
      if (live.checkOverlap) {
        live.checkOverlap = false
        const overlap = overlapText(await mirrorOf($))
        if (overlap) return withContext(result, overlap)
      }
      live.toolsThisTurn += 1
      if (live.nudgeAfter <= 0 || live.isNudged || live.sawTaskTool || live.toolsThisTurn < live.nudgeAfter)
        return result
      if (openTasks(await mirrorOf($)).length > 0) return result
      live.isNudged = true
      return withContext(result, nudgeText(live.toolsThisTurn))
    }
    // A subagent's task call ran on the engine's own tools; its list stays out of this session's.
    return result
  })

  // The task tool itself knows no hold state; its description teaches the convention.
  on('tool.describe', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: `${described.description}\n\n${HOLD_HELP}` }
  })
}

export const register: Register = (on, options) => {
  // The settings come from the mod's own file over the loaded options, read again as it changes.
  settings(on, options, values => {
    live.nudgeAfter = Number(values.nudgeAfterTools ?? 3)
    live.keepGoing = values.keepGoing !== false
  })

  registerLifecycle(on)
  registerTurns(on)
  registerPrompts(on)
  registerTools(on)
}

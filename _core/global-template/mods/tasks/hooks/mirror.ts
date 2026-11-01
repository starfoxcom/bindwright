// The task list as data: pure rules over the mirror, with no engine handle, so each takes the mirror as a value.

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type MirrorTask = {
  id: string
  subject: string
  activeForm?: string
  status: TaskStatus
  createdTurn: number
  startedTurn?: number
  doneTurn?: number
  doneAt?: number
  // Set while the task waits on something outside it (a decision, another task); the reason.
  hold?: string
  // Set when the task was deleted unfinished: kept in the list as dropped, not done.
  droppedAt?: number
  description?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  // Metadata other than hold, merged as the engine's tool does (a null value removes a key).
  metadata?: Record<string, unknown>
}

// updatedAt moves on every task tool call; changedAt only when the list changed.
export type Mirror = {
  session: string
  // The session's working folder, lowercased with forward slashes: how a new session finds its predecessor.
  root?: string
  updatedAt: number
  changedAt?: number
  turn: number
  tasks: MirrorTask[]
  // The id the next TaskCreate gets; ids never repeat within a session, even after the 50-task trim.
  nextId?: number
  // The previous session's unfinished tasks in this folder, shown for checking, never recreated here.
  carried?: MirrorTask[]
  carriedFrom?: string
  // The carried list's `updatedAt` when it was read: a list saved again since then is not marked.
  carriedUpdatedAt?: number
  // Set once the carried-over note reached the model; kept on disk so a hot reload never repeats it.
  isCarryNoted?: boolean
  // Marks a clean end (session.end). The running stamp lives in its own `<session>.alive` file.
  endedAt?: number
  // Set on a finished session's list once a newer session carried its leftovers: they are shown
  // once, in that session, never again in every session after it.
  handedOverAt?: number
}

type UpdateArgs = {
  taskId?: string
  status?: string
  subject?: string
  activeForm?: string
  metadata?: { hold?: string | null }
}
// The four task tools' arguments, as the engine's schemas define them.
export type TaskArgs = UpdateArgs & {
  description?: string
  owner?: string
  addBlocks?: string[]
  addBlockedBy?: string[]
}

export const ALIVE_EVERY_MS = 60_000
// Missed heartbeats this long mean the session is gone (closed without an end, or crashed).
const ALIVE_STALE_MS = 3 * ALIVE_EVERY_MS

// One task file in the engine's own store (`<config>/tasks/<session>/<id>.json`).
export type EngineTask = {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
}

// Copies the engine's tasks the mirror lacks (a session from before the mod answered the tools); the
// mirror's own copy wins for ids it already has. Returns whether the list changed.
export function importEngineTasks(mirror: Mirror, found: readonly EngineTask[], turn: number, now: number): boolean {
  let isChanged = false
  for (const item of found) {
    const id = String(item.id)
    if (mirror.tasks.some(task => task.id === id)) continue
    applyCreate(mirror, id, String(item.subject ?? `Task #${id}`), item.activeForm, turn)
    const task = mirror.tasks.find(entry => entry.id === id) as MirrorTask
    if (item.description) task.description = item.description
    if (item.owner) task.owner = item.owner
    if (item.blocks?.length) task.blocks = item.blocks.map(String)
    if (item.blockedBy?.length) task.blockedBy = item.blockedBy.map(String)
    applyUpdate(
      mirror,
      { taskId: id, status: item.status, metadata: item.metadata as UpdateArgs['metadata'] },
      turn,
      now,
    )
    isChanged = true
  }
  if (isChanged) {
    const highest = Math.max(0, ...mirror.tasks.map(task => Number(task.id) || 0))
    mirror.nextId = Math.max(mirror.nextId ?? 1, highest + 1)
  }
  return isChanged
}

export function openTasks(mirror: Mirror): MirrorTask[] {
  return mirror.tasks.filter(task => task.status !== 'completed' && !task.droppedAt)
}

function inProgress(mirror: Mirror): MirrorTask[] {
  return mirror.tasks.filter(task => task.status === 'in_progress' && !task.hold && !task.droppedAt)
}

export function applyCreate(
  mirror: Mirror,
  id: string,
  subject: string,
  activeForm: string | undefined,
  turn: number,
): void {
  mirror.tasks = mirror.tasks.filter(task => task.id !== id)
  mirror.tasks.push({ id, subject, activeForm, status: 'pending', createdTurn: turn })
}

export function applyUpdate(mirror: Mirror, args: UpdateArgs, turn: number, now: number): void {
  const id = String(args.taskId ?? '')
  if (args.status === 'deleted') {
    const gone = mirror.tasks.find(task => task.id === id)
    if (gone && gone.status !== 'completed') {
      gone.droppedAt = now
      delete gone.hold
    } else mirror.tasks = mirror.tasks.filter(task => task.id !== id)
    return
  }
  let task = mirror.tasks.find(item => item.id === id)
  if (!task) {
    task = { id, subject: args.subject ?? `Task #${id}`, status: 'pending', createdTurn: turn }
    mirror.tasks.push(task)
  }
  if (args.subject) task.subject = args.subject
  if (args.activeForm) task.activeForm = args.activeForm
  if (args.status === 'in_progress' && task.status !== 'in_progress') {
    task.status = 'in_progress'
    task.startedTurn = turn
  } else if (args.status === 'completed' && task.status !== 'completed') {
    task.status = 'completed'
    task.doneTurn = turn
    task.doneAt = now
  } else if (args.status === 'pending') {
    task.status = 'pending'
    task.startedTurn = undefined
  }
  if (args.status === 'completed' || args.status === 'in_progress') delete task.hold
  const metadata = metadataOf(args.metadata)
  if (!metadata) return
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'hold') {
      if (typeof value === 'string' && value.trim()) task.hold = value.trim()
      else delete task.hold
    } else if (value === null) {
      if (task.metadata) delete task.metadata[key]
    } else task.metadata = { ...task.metadata, [key]: value }
  }
}

// The model sometimes sends metadata as a JSON string.
function metadataOf(raw: unknown): Record<string, unknown> | undefined {
  let metadata = raw
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata)
    } catch {
      return undefined
    }
  }
  return metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : undefined
}

function findTask(mirror: Mirror, id: string): MirrorTask | undefined {
  return mirror.tasks.find(task => task.id === id && !task.droppedAt)
}

function link(
  mirror: Mirror,
  from: MirrorTask,
  ids: readonly unknown[] | undefined,
  side: 'blocks' | 'blockedBy',
): boolean {
  let isChanged = false
  for (const raw of ids ?? []) {
    const other = findTask(mirror, String(raw))
    if (!other || other.id === from.id) continue
    const back = side === 'blocks' ? 'blockedBy' : 'blocks'
    if (!(from[side] ?? []).includes(other.id)) {
      from[side] = [...(from[side] ?? []), other.id]
      isChanged = true
    }
    if (!(other[back] ?? []).includes(from.id)) other[back] = [...(other[back] ?? []), from.id]
  }
  return isChanged
}

function createTask(mirror: Mirror, args: TaskArgs, turn: number, now: number): unknown {
  const highest = Math.max(0, ...mirror.tasks.map(task => Number(task.id) || 0))
  const id = String(Math.max(mirror.nextId ?? 1, highest + 1))
  mirror.nextId = Number(id) + 1
  applyCreate(mirror, id, String(args.subject ?? `Task #${id}`), args.activeForm, turn)
  const task = findTask(mirror, id) as MirrorTask
  if (args.description) task.description = String(args.description)
  if (args.metadata !== undefined) applyUpdate(mirror, { taskId: id, metadata: args.metadata }, turn, now)
  return { task: { id, subject: task.subject } }
}

function getTask(mirror: Mirror, args: TaskArgs): unknown {
  const task = findTask(mirror, String(args.taskId ?? ''))
  if (!task) return { task: null }
  const { id, subject, status } = task
  const description = task.description ?? ''
  return { task: { id, subject, description, status, blocks: task.blocks ?? [], blockedBy: task.blockedBy ?? [] } }
}

function listTasks(mirror: Mirror): unknown {
  const done = new Set(mirror.tasks.filter(task => task.status === 'completed').map(task => task.id))
  const tasks = mirror.tasks.filter(task => !task.droppedAt)
  return {
    tasks: tasks.map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      owner: task.owner,
      blockedBy: (task.blockedBy ?? []).filter(id => !done.has(id)),
    })),
  }
}

// The fields an update changes, as the engine's TaskUpdate names them; description and owner are set here.
function changedFields(mirror: Mirror, task: MirrorTask, args: TaskArgs): string[] {
  const fields: string[] = []
  if (args.subject !== undefined && args.subject !== task.subject) fields.push('subject')
  if (args.description !== undefined && args.description !== task.description) {
    task.description = String(args.description)
    fields.push('description')
  }
  if (args.activeForm !== undefined && args.activeForm !== task.activeForm) fields.push('activeForm')
  if (args.owner !== undefined && args.owner !== task.owner) {
    task.owner = String(args.owner)
    fields.push('owner')
  }
  if (args.metadata !== undefined) fields.push('metadata')
  if (link(mirror, task, args.addBlocks, 'blocks')) fields.push('blocks')
  if (link(mirror, task, args.addBlockedBy, 'blockedBy')) fields.push('blockedBy')
  return fields
}

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted'])

function updateTask(mirror: Mirror, args: TaskArgs, turn: number, now: number): unknown {
  const id = String(args.taskId ?? '')
  const task = findTask(mirror, id)
  if (!task) return { success: false, taskId: id, updatedFields: [], error: 'Task not found' }
  const from = task.status
  // The engine's own tool refuses any other status; a reply claiming a change that never happened would
  // leave the model believing a task finished while every view still shows it open.
  if (args.status !== undefined && !STATUSES.has(String(args.status))) {
    const error = 'status must be pending, in_progress, completed or deleted'
    return { success: false, taskId: id, updatedFields: [], error }
  }
  if (args.status === 'deleted') {
    applyUpdate(mirror, args, turn, now)
    return { success: true, taskId: id, updatedFields: ['deleted'], statusChange: { from, to: 'deleted' } }
  }
  const fields = changedFields(mirror, task, args)
  const isStatusChange = args.status !== undefined && args.status !== from
  if (isStatusChange) fields.push('status')
  applyUpdate(mirror, args, turn, now)
  return {
    success: true,
    taskId: id,
    updatedFields: fields,
    statusChange: isStatusChange ? { from, to: args.status } : undefined,
  }
}

// Answers one task tool call from the mirror, returning the record the engine's own tool returns
// (core maps it to the model's text with that tool's mapper, so the model reads the usual results).
export function answerTool(mirror: Mirror, tool: string, args: TaskArgs, turn: number, now: number): unknown {
  if (tool === 'TaskCreate') return createTask(mirror, args, turn, now)
  if (tool === 'TaskGet') return getTask(mirror, args)
  if (tool === 'TaskList') return listTasks(mirror)
  return updateTask(mirror, args, turn, now)
}

function label(task: MirrorTask): string {
  return `#${task.id} "${task.subject}"`
}

export function openListText(mirror: Mirror, turn: number): string | null {
  const open = openTasks(mirror)
  if (open.length === 0) return null
  const parts = open.map(task =>
    task.hold
      ? `on hold ${label(task)} (waits on: ${task.hold})`
      : task.status === 'in_progress'
        ? `in progress ${label(task)} (${Math.max(0, turn - (task.startedTurn ?? turn))} turn(s))`
        : `pending ${label(task)}`,
  )
  return `[tasks] Open: ${parts.join('; ')}. Mark each task completed the moment it is done; keep one in progress.`
}

export function staleText(mirror: Mirror, turn: number): string | undefined {
  const stale = inProgress(mirror).filter(task => (task.startedTurn ?? turn) <= turn)
  if (stale.length === 0) return undefined
  return (
    `[tasks] Still in progress from an earlier turn: ${stale.map(label).join(', ')}. If finished, mark ` +
    `completed before new work.`
  )
}

export function overlapText(mirror: Mirror): string | undefined {
  const running = inProgress(mirror)
  if (running.length < 2) return undefined
  return (
    `[tasks] ${running.map(label).join(' and ')} are all in progress. Work one at a time: mark the finished ` +
    `one completed, or set the others back to pending.`
  )
}

export function carriedText(carried: readonly MirrorTask[]): string {
  const parts = carried.map(task => `#${task.id} "${task.subject}"${task.hold ? ` (on hold: ${task.hold})` : ''}`)
  return (
    `[tasks] The previous session in this folder left unfinished: ${parts.join('; ')}. ` +
    'Check them against the hand-off: recreate the ones still valid with TaskCreate, leave the rest.'
  )
}

// A running session writes the time to `<session>.alive` every minute and at each turn; it is a
// file of its own so the stamp never rewrites a task list. A session is finished when it never
// stamped (gone before the stamps existed), stopped stamping, or ended after its last stamp.
export function isFinished(endedAt: number | undefined, aliveAt: number | undefined, now: number): boolean {
  // A stamp that is not a number (a damaged or foreign file) counts as no stamp.
  if (aliveAt === undefined || !Number.isFinite(aliveAt) || now - aliveAt > ALIVE_STALE_MS) return true
  return endedAt !== undefined && endedAt >= aliveAt
}

// The newest other finished session in the same folder that left open tasks.
export function pickPredecessor(
  mirrors: readonly Mirror[],
  aliveAt: ReadonlyMap<string, number>,
  root: string,
  session: string,
  now: number,
): Mirror | undefined {
  return mirrors
    .filter(mirror => mirror.session !== session && mirror.root === root && !mirror.handedOverAt)
    .filter(mirror => openTasks(mirror).length > 0)
    .filter(mirror => isFinished(mirror.endedAt, aliveAt.get(mirror.session), now))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function nudgeText(tools: number): string {
  return (
    `[tasks] This turn ran ${tools} tool calls with no task list. If the work has 3+ steps, create the tasks ` +
    `now (TaskCreate) and keep their status current.`
  )
}

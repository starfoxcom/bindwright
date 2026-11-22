import type { Mirror, MirrorTask } from './mirror'
import { openTasks } from './mirror'
import { maskCommand } from './shellmask'

// A commit lands a code change, so it waits until the task list changed since the last commit, and the
// first file edit after a change names the task it belongs to. Reading or listing the tasks is no change.

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// `git commit` as a command, after any of git's own options (`git -C dir commit`, `git -c k=v commit`),
// matched on the masked command (`shellmask.ts`), so message text never counts, and on the whole
// subcommand word, so `git commit-tree` is not a commit. A `--name` option is read one way only, so a
// long run of them cannot make the match backtrack.
const GIT_OPTS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-(?!-|[Cc](?:\s|$))[\w-]+(?:=\S+)?))*`
const COMMIT = new RegExp(String.raw`(?:^|[\s;&|({])git(?:\.exe)?${GIT_OPTS}\s+commit(?![\w-])`)
// The characters of a task's description shown when a commit waits; the rest is one TaskGet away.
const SHOWN = 160

const state = { isListChanged: false, isEditNoted: false }

export function isCommit(command: string, isPowerShell = false): boolean {
  return COMMIT.test(maskCommand(command, isPowerShell))
}

/** A task call changed the list: the next commit may go, and the next edit is noted again. */
export function noteListChanged(): void {
  state.isListChanged = true
  state.isEditNoted = false
}

/** The session ended (a /clear goes on in this process): the next session starts with its commit held. */
export function resetReview(): void {
  state.isListChanged = false
  state.isEditNoted = false
}

/** A commit went through: the one after it waits for the next change to the list. */
export function noteCommitted(): void {
  state.isListChanged = false
}

function line(task: MirrorTask): string {
  const where = task.hold ? `on hold, waits on: ${task.hold}` : task.status.replace('_', ' ')
  const text = task.description ?? ''
  const about = text ? ` ${text.slice(0, SHOWN)}${text.length > SHOWN ? '...' : ''}` : ''
  return `- #${task.id} "${task.subject}" (${where}).${about}`
}

/** Why a commit waits, with every open task to check, or undefined when it may go. */
export function commitRefusal(mirror: Mirror): string | undefined {
  if (state.isListChanged) return undefined
  const open = openTasks(mirror)
  return (
    '[tasks] Update the task list before this commit: put what the commit does on the task it belongs to ' +
    '(TaskUpdate its description or status, or TaskCreate one; mcp__tasks__taskmod_update and _create where ' +
    'those stand in), then check that each open task below still ' +
    'says what is true now and fix any that does not. The commit goes through once the list has changed.\n' +
    (open.length > 0 ? open.map(line).join('\n') : '- (no open tasks)')
  )
}

/** The note for the first file edit since the list last changed, or undefined after it. */
export function editNote(mirror: Mirror): string | undefined {
  if (state.isEditNoted) return undefined
  state.isEditNoted = true
  const running = openTasks(mirror).find(task => task.status === 'in_progress' && !task.hold)
  return running
    ? `[tasks] Code changed: record it on #${running.id} "${running.subject}" if it belongs there, or on the ` +
        'task it does belong to, before the next commit.'
    : '[tasks] Code changed with no task in progress: start or create the task it belongs to before the next commit.'
}

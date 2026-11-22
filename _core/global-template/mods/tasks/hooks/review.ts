import type { Mirror, MirrorTask } from './mirror'
import { openTasks } from './mirror'

// A commit lands a code change, so it waits until the task list changed since the last commit, and the
// first file edit after a change names the task it belongs to. Reading or listing the tasks is no change.

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// `git commit` as a command, after any of git's own options (`git -C dir commit`, `git -c k=v commit`),
// matched on the command with its quoted text and here-doc bodies blanked, so message text never counts,
// and on the whole subcommand word, so `git commit-tree` is not a commit. The ci-watch mod reads its
// commands the same way; each mod carries its own copy.
const GIT_OPTS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-(?![Cc](?:\s|$))[\w-]+(?:=\S+)?))*`
const COMMIT = new RegExp(String.raw`(?:^|[\s;&|({])git(?:\.exe)?${GIT_OPTS}\s+commit(?![\w-])`)
// Each shell's own escape inside double quotes: a backslash in Bash, a backtick in PowerShell.
const DOUBLE_QUOTED = {
  bash: String.raw`"(?:[^"\\]|\\[\s\S])*"`,
  powershell: '"(?:[^"`]|`[\\s\\S])*"',
}
// The characters of a task's description shown when a commit waits; the rest is one TaskGet away.
const SHOWN = 160

const state = { isListChanged: false, isEditNoted: false }

// Which lines are here-doc bodies (and their end lines): they hold text, never commands.
function hereDocLines(lines: readonly string[]): Set<number> {
  const body = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    // `<<` alone: `<<<` feeds one word. Found with the line's quoted text blanked, so a `<<EOF` inside a
    // message opens nothing.
    const unquoted = (lines[i] ?? '').replace(/(?<!<<-?\s*)(?:'[^']*'|"(?:[^"\\`]|[\\`].)*")/g, '""')
    const doc = /(?<!<)<<(?!<)-?\s*(["']?)([A-Za-z_][\w.-]*)\1/.exec(unquoted)
    if (!doc) continue
    while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== doc[2]) body.add(++i)
    if (i + 1 < lines.length) body.add(++i)
  }
  return body
}

function commandWords(command: string, isPowerShell: boolean): string {
  const lines = command.split('\n')
  const body = hereDocLines(lines)
  const quoted = String.raw`@'[\s\S]*?'@|@"[\s\S]*?"@|'[^']*'|${DOUBLE_QUOTED[isPowerShell ? 'powershell' : 'bash']}`
  return lines
    .filter((_, i) => !body.has(i))
    .join('\n')
    .replace(new RegExp(quoted, 'g'), '""')
}

export function isCommit(command: string, isPowerShell = false): boolean {
  return COMMIT.test(commandWords(command, isPowerShell))
}

/** A task call changed the list: the next commit may go, and the next edit is noted again. */
export function noteListChanged(): void {
  state.isListChanged = true
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

// What a shell command does, read from its text: a push or `gh pr create` (which starts a watch), a
// `gh pr merge` (which drops one), and the folder it ran in. Pure, no engine access.

// Read on the command with its quoted text and here-doc bodies blanked (see `commandWords`), and on
// the subcommand word: `git commit -m "explain the push"` is not a push. Global options may come first.
const GH_OPTS = String.raw`(?:\s+(?:-R\s+\S+|--repo[=\s]\S+))*`
const AT_START = String.raw`(?:^|[\s;&|({])`
const PR_CREATE = new RegExp(`${AT_START}gh${GH_OPTS}\\s+pr${GH_OPTS}\\s+create\\b`)
// git's global options that take the next word as their value (`git -C dir push`, `git -c k=v commit`),
// as git itself reads them; every other option before the subcommand is one word.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const PR_MERGE = new RegExp(`${AT_START}gh${GH_OPTS}\\s+pr${GH_OPTS}\\s+merge\\b([^|;&\\n]*)`)

// The command with quoted strings emptied and here-doc bodies dropped, so message text never reads as
// a command. Folders come from the raw command (`targetFolder`).
// Each shell's own escape inside double quotes: a backslash in Bash (where a backtick runs a command and
// escapes nothing), a backtick in PowerShell (where a backslash is a plain character).
const DOUBLE_QUOTED = {
  bash: String.raw`"(?:[^"\\]|\\[\s\S])*"`,
  powershell: '"(?:[^"`]|`[\\s\\S])*"',
}

// Which lines are here-doc bodies (and their end lines): they hold text, never commands.
function hereDocLines(lines: readonly string[]): Set<number> {
  const body = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    // `<<` alone: `<<<` feeds one word, not the lines after it. Found on the line with its quoted text
    // blanked (a delimiter's own quotes kept), so a `<<EOF` inside a message opens nothing.
    const unquoted = (lines[i] ?? '').replace(/(?<!<<-?\s*)(?:'[^']*'|"(?:[^"\\`]|[\\`].)*")/g, '""')
    const doc = /(?<!<)<<(?!<)-?\s*(["']?)([A-Za-z_][\w.-]*)\1/.exec(unquoted)
    if (!doc) continue
    while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== doc[2]) body.add(++i)
    if (i + 1 < lines.length) body.add(++i)
  }
  return body
}

const quotedSpans = (isPowerShell: boolean) =>
  new RegExp(
    String.raw`@'[\s\S]*?'@|@"[\s\S]*?"@|'[^']*'|${isPowerShell ? DOUBLE_QUOTED.powershell : DOUBLE_QUOTED.bash}`,
    'g',
  )

export function commandWords(command: string, isPowerShell = false): string {
  const lines = command.split('\n')
  const body = hereDocLines(lines)
  return lines
    .filter((_, i) => !body.has(i))
    .join('\n')
    .replace(quotedSpans(isPowerShell), '""')
}

// The command at full length, with here-doc bodies blanked and the inside of each quoted string filled
// with `_`: a match on it sits at the same place in the command, and message text matches nothing.
function maskedCommand(command: string, isPowerShell: boolean): string {
  const lines = command.split('\n')
  const body = hereDocLines(lines)
  return lines
    .map((line, i) => (body.has(i) ? ' '.repeat(line.length) : line))
    .join('\n')
    .replace(quotedSpans(isPowerShell), span => span[0] + '_'.repeat(span.length - 2) + span[span.length - 1])
}

// The subcommand of each git call in the command, read word by word as git does: the first word after
// `git` and its global options. An option's value is never read as the subcommand. Words split as the
// shell splits them: a line continuation joins lines, and `<` or `>` ends a word even glued to it.
function gitSubcommands(command: string, isPowerShell: boolean): string[] {
  const found: string[] = []
  const joined = commandWords(command, isPowerShell).replace(isPowerShell ? /`\r?\n/g : /\\\r?\n/g, ' ')
  for (const part of joined.split(/[;&|\n(){}]/)) {
    const words = part.trim().split(/[\s<>]+/)
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== 'git') continue
      let next = i + 1
      while (words[next]?.startsWith('-')) next += GIT_VALUE_OPTIONS.has(words[next] ?? '') ? 2 : 1
      if (words[next]) found.push(words[next] ?? '')
    }
  }
  return found
}

export function isPushOrPr(command: string, isPowerShell = false): boolean {
  return gitSubcommands(command, isPowerShell).includes('push') || PR_CREATE.test(commandWords(command, isPowerShell))
}

// A step back holds these until it is done: the fix waits for the research.
export function isCommitOrPush(command: string, isPowerShell = false): boolean {
  return gitSubcommands(command, isPowerShell).some(word => word === 'commit' || word === 'push')
}

// A merged PR's watch is noise: the chat already says it merged. Returns the
// PR number a `gh pr merge` names, 0 when it names none (the branch's PR).
export function mergedNumber(command: string, isPowerShell = false): number | undefined {
  const merge = PR_MERGE.exec(commandWords(command, isPowerShell))
  if (!merge) return undefined
  const named = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(merge[1] ?? '')
  return named ? Number(named[1]) : 0
}

// The folder a push or `gh pr create` ran in: `git -C <dir>` or the `cd <dir>` / `Set-Location <dir>`
// steps before it, on the same line or the lines above. Undefined means the session's folder.
const GIT_C = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/
const CD = /(?:^|[;&|\n]\s*)(?:cd|Set-Location|Push-Location|pushd)\s+(?:-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/g
const PUSH_AT = /\bgit\b[^;&|\n]*\bpush\b|\bgh\s+pr\s+create\b/
const ABSOLUTE = /^(?:[a-zA-Z]:|[/\\~])/

// The patterns run on the masked command, so text inside quotes or here-docs steers nothing; each path
// is then read from the command at the same place.
export function targetFolder(command: string, isWindows: boolean, isPowerShell = false): string | undefined {
  // Git Bash paths (/c/Users/...) mean nothing to a Windows process: turn them into C:/Users/...
  // Only on Windows: elsewhere `/u/me` is a real one-letter folder.
  const masked = maskedCommand(command, isPowerShell)
  const pathAt = (match: RegExpExecArray | RegExpMatchArray, offset = 0) => {
    const at = offset + (match.index ?? 0) + match[0].length - match[1]!.length
    const bare = command.slice(at, at + match[1]!.length).replace(/^["']|["']$/g, '')
    return isWindows ? bare.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : bare
  }
  const push = PUSH_AT.exec(masked)
  // `git -C <dir>` on the push itself wins.
  const gitC = push ? GIT_C.exec(push[0]) : null
  if (push && gitC) return pathAt(gitC, push.index)
  // Each `cd` before the push moves on from the one before it, unless it names a whole path.
  let folder: string | undefined
  for (const step of masked.slice(0, push?.index ?? masked.length).matchAll(CD)) {
    const next = pathAt(step)
    folder = folder === undefined || ABSOLUTE.test(next) ? next : `${folder}/${next}`
  }
  return folder
}

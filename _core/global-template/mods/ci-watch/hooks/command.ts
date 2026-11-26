// What a shell command does, read from its text: a push or `gh pr create` (which starts a watch), a
// `gh pr merge` (which drops one), and the folder it ran in. Pure, no engine access.

import { maskCommand } from './shellmask'

// Matched on the command with its message text hidden (`shellmask.ts`), and on the subcommand word:
// `git commit -m "explain the push"` is not a push. Global options may come first; `-c` and `-C` always
// take the next word as their value, so a value (`-c push.default=x`) is never read as the subcommand.
// A `--name` option is read one way only, so a long run of them cannot make the match backtrack.
const GIT_OPTS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-(?!-|[Cc](?:\s|$))[\w-]+(?:=\S+)?))*`
const GH_OPTS = String.raw`(?:\s+(?:-R\s+\S+|--repo[=\s]\S+))*`
const AT_START = String.raw`(?:^|[\s;&|({])`
const PUSH = `${AT_START}git${GIT_OPTS}\\s+push\\b`
const COMMIT_OR_PUSH = new RegExp(`${AT_START}git${GIT_OPTS}\\s+(?:commit|push)(?![\\w-])`)
const PR_CREATE = `${AT_START}gh${GH_OPTS}\\s+pr${GH_OPTS}\\s+create\\b`
const PUSH_OR_PR = new RegExp(`${PUSH}|${PR_CREATE}`)
const PR_CREATE_ONLY = new RegExp(PR_CREATE)
const PR_MERGE = new RegExp(`${AT_START}gh${GH_OPTS}\\s+pr${GH_OPTS}\\s+merge\\b([^|;&\\n]*)`)

export function isPushOrPr(command: string, isPowerShell = false): boolean {
  return PUSH_OR_PR.test(maskCommand(command, isPowerShell))
}

// A new PR waits for its first round's research.
export function isPrCreate(command: string, isPowerShell = false): boolean {
  return PR_CREATE_ONLY.test(maskCommand(command, isPowerShell))
}

// A step back holds these until it is done: the fix waits for the research.
export function isCommitOrPush(command: string, isPowerShell = false): boolean {
  return COMMIT_OR_PUSH.test(maskCommand(command, isPowerShell))
}

// A merged PR's watch is noise: the chat already says it merged. Returns the
// PR number a `gh pr merge` names, 0 when it names none (the branch's PR).
export function mergedNumber(command: string, isPowerShell = false): number | undefined {
  const merge = PR_MERGE.exec(maskCommand(command, isPowerShell))
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
  const masked = maskCommand(command, isPowerShell)
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

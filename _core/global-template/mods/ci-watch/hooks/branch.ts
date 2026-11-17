import type { EngineInterface } from 'claude-code'

import { plainPush } from './plain'

// Whether a piece of work is the red PR's, so a step back holds only that work. Work is the PR's when
// its folder is on the PR's branch or its history holds any of the PR's commits, whatever the branch is
// called; git answers each question, and any answer that is not a clean no keeps the hold.

/** Where a piece of work acts: a folder (undefined for the shell's own), and whether it pushes from there. */
export type WorkStep = { folder?: string; isPush?: boolean }

/** The red PR's head branch and its commits as GitHub lists them now; a branch built on its work holds one. */
export type RedPr = { branch: string; commits: readonly string[] }

type GitAnswer = { exitCode: number; out: string }
const NO_ANSWER: GitAnswer = { exitCode: -1, out: '' }

// What git answers in `folder`, or in the shell's folder when undefined: the one its last `cd` left it in,
// which the session's folder follows, read again on every call. Output cut at the engine's limit, a
// timeout or a failure to start is no answer.
async function gitIn($: EngineInterface, folder: string | undefined, args: readonly string[]): Promise<GitAnswer> {
  try {
    const cwd = await $.session.cwd()
    const run = await $.process.run(['git', '-C', folder ?? cwd, ...args], { cwd, timeoutMs: 10_000 })
    return run.isStdoutTruncated ? NO_ANSWER : { exitCode: run.exitCode, out: run.stdout.trim() }
  } catch {
    return NO_ANSWER
  }
}

// Whether the folder's history holds any of `commits`. `git merge-base --is-ancestor` exits 0 for yes and
// 1 for no; anything else (a commit the repo lacks, a failure) is no answer, which counts as yes.
async function holdsAny($: EngineInterface, folder: string | undefined, commits: readonly string[]) {
  for (const commit of commits) {
    if ((await gitIn($, folder, ['merge-base', '--is-ancestor', commit, 'HEAD'])).exitCode !== 1) return true
  }
  return false
}

// Config keys under which a plain push may send refs it does not name, delete or force them, or push
// another repository: a mirror or push refspec on a remote, and submodule recursion. Any value counts.
const PUSHES_ELSEWHERE = /^(?:remote\..+\.(?:mirror|push)|push\.recursesubmodules|submodule\.recurse)$/
// The `push.default` values under which a push of plain names sends each to its own name, or nothing.
const SAME_NAME_PUSHES = new Set(['simple', 'current', 'nothing'])

/**
 * Whether a folder's config, as `git config --null --list` prints it (each entry `key`, or `key` and a
 * newline and its value, ending in a NUL), may send a push past the names it carries. An unread config
 * counts as one.
 */
function pushesMore(config: GitAnswer): boolean {
  if (config.exitCode !== 0 || !config.out) return true
  return config.out.split('\0').some(entry => {
    const end = entry.indexOf('\n')
    const key = (end < 0 ? entry : entry.slice(0, end)).toLowerCase()
    if (PUSHES_ELSEWHERE.test(key)) return true
    return key === 'push.default' && !SAME_NAME_PUSHES.has(end < 0 ? '' : entry.slice(end + 1).trim().toLowerCase())
  })
}

/** The folder holding the file an edit names, or undefined without a path. A root keeps its separator. */
export function folderOf(e: unknown): string | undefined {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  if (typeof path !== 'string' || !/[\\/]/.test(path)) return undefined
  const folder = path.replace(/[\\/][^\\/]*$/, '')
  // `/a.ts` is in `/` and `C:\a.ts` in `C:\`; a bare `C:` is that drive's current folder instead.
  return folder === '' || /^[a-zA-Z]:$/.test(folder) ? folder + path[folder.length] : folder
}

/**
 * A plain Bash commit or push, which acts in the shell's folder, as one step; null for anything else. The
 * PowerShell tool keeps a folder of its own, which the session's folder may not follow.
 */
export function commandSteps(command: string, isPowerShell: boolean): WorkStep[] | null {
  const isPush = isPowerShell ? null : plainPush(command)
  return isPush === null ? null : [{ isPush }]
}

// Whether a push from `folder` may carry the red PR's work: a local branch holds any of its commits (each
// `--contains` adds one, and a branch holding any is listed), or the config may send refs the push does
// not name. A push of names that hold none of its commits can update the PR's branch only by force, which
// no plain push asks for.
async function mayPushRedWork($: EngineInterface, folder: string | undefined, red: RedPr): Promise<boolean> {
  const contains = red.commits.flatMap(commit => ['--contains', commit])
  const refs = await gitIn($, folder, ['for-each-ref', ...contains, '--format=%(refname)', 'refs/heads/'])
  if (refs.exitCode !== 0 || refs.out) return true
  return pushesMore(await gitIn($, folder, ['config', '--null', '--list']))
}

/**
 * Whether the work may be the red PR's: in the folder of any of `steps`, its branch is checked out or the
 * history holds any of its commits, a push there may carry its work, or the command names its branch.
 * Branch names compare without case, as refs do on Windows and macOS. An unknown PR, unread steps or any
 * answer from git that is not a clean no count as yes, so a hold never lifts on a guess.
 */
export async function mayBeOn(
  $: EngineInterface,
  red: RedPr | undefined,
  steps: readonly WorkStep[] | null,
  command = '',
): Promise<boolean> {
  const wanted = red?.branch.toLowerCase()
  if (!red || !wanted || !steps || command.toLowerCase().includes(wanted)) return true
  for (const { folder, isPush } of steps) {
    const name = await gitIn($, folder, ['branch', '--show-current'])
    if (name.exitCode !== 0 || name.out.toLowerCase() === wanted) return true
    if (await holdsAny($, folder, red.commits)) return true
    if (isPush && (await mayPushRedWork($, folder, red))) return true
  }
  return false
}

import type { EngineInterface } from 'claude-code'

import { plainPush } from './plain'

// Which branch a piece of work is on, so a step back holds only the red PR's work.

/** Where a piece of work acts: a folder (undefined for the shell's own), and whether it pushes from there. */
export type WorkStep = { folder?: string; isPush?: boolean }

async function git($: EngineInterface, cwd: string, folder: string, args: readonly string[]) {
  try {
    const { stdout, exitCode } = await $.process.run(['git', '-C', folder, ...args], { cwd, timeoutMs: 10_000 })
    return exitCode === 0 ? stdout.trim() : ''
  } catch {
    return ''
  }
}

// What git reports in `folder`, or in the shell's folder when undefined: the one its last `cd` left it in,
// which the session's folder follows, read again on every call.
async function gitIn($: EngineInterface, folder: string | undefined, args: readonly string[]) {
  const cwd = await $.session.cwd()
  return git($, cwd, folder ?? cwd, args)
}

// A push config that may send more than the checked-out branch, or send a named branch to another name: a
// mirror remote, a `remote.<name>.push` refspec, `push.default=matching`, or `upstream` (old name
// `tracking`), which sends each named branch to its own upstream. A folder whose config cannot be read
// counts as one.
const PUSHES_MORE = /^(?:remote\..+\.(?:mirror|push)=|push\.default=(?:matching|upstream|tracking)$)/im

/** The folder holding the file an edit names, or undefined without a path. */
export function folderOf(e: unknown): string | undefined {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  if (typeof path !== 'string' || !/[\\/]/.test(path)) return undefined
  return path.replace(/[\\/][^\\/]*$/, '') || undefined
}

/**
 * A plain Bash commit or push, which acts in the shell's folder, as one step; null for anything else. The
 * PowerShell tool keeps a folder of its own, which the session's folder may not follow.
 */
export function commandSteps(command: string, isPowerShell: boolean): WorkStep[] | null {
  const isPush = isPowerShell ? null : plainPush(command)
  return isPush === null ? null : [{ isPush }]
}

/**
 * Whether the work may be on `branch`: it is checked out, or pushed to, in the folder of any of `steps`,
 * a push there may send it, or the command names it. Branch names compare without case, as refs do on
 * Windows and macOS. Unread steps or an unread branch count as yes, so a hold never lifts on a guess.
 */
export async function mayBeOn(
  $: EngineInterface,
  branch: string | undefined,
  steps: readonly WorkStep[] | null,
  command = '',
): Promise<boolean> {
  const wanted = branch?.toLowerCase()
  if (!wanted || !steps || command.toLowerCase().includes(wanted)) return true
  for (const { folder, isPush } of steps) {
    const name = (await gitIn($, folder, ['branch', '--show-current'])).toLowerCase()
    if (!name || name === wanted) return true
    const upstream = await gitIn($, folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    if (upstream.toLowerCase().endsWith(`/${wanted}`)) return true
    if (isPush) {
      const config = await gitIn($, folder, ['config', '--list'])
      if (!config || PUSHES_MORE.test(config)) return true
    }
  }
  return false
}

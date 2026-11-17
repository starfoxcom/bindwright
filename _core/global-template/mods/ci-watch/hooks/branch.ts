import type { EngineInterface } from 'claude-code'

import { plainPush } from './plain'

// Which branch a piece of work is on, so a step back holds only the red PR's work.

/** Where a piece of work acts: a folder (undefined for the shell's own), and whether it pushes from there. */
export type WorkStep = { folder?: string; isPush?: boolean }

async function git($: EngineInterface, cwd: string, folder: string, args: readonly string[]) {
  try {
    const run = await $.process.run(['git', '-C', folder, ...args], { cwd, timeoutMs: 10_000 })
    // Output cut at the engine's limit is read as no answer, so a key past the cut can never lift a hold.
    return run.exitCode === 0 && !run.isStdoutTruncated ? run.stdout.trim() : ''
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

// The `push.default` values under which a push of plain names sends each to its own name, or nothing.
const SAME_NAME_PUSHES = new Set(['simple', 'current', 'nothing'])

/**
 * Whether a folder's config, as `git config --null --list` prints it (each entry `key`, or `key` and a
 * newline and its value, ending in a NUL), may send a push past the names it carries: any mirror or push
 * refspec on a remote, whatever its value, or a `push.default` outside SAME_NAME_PUSHES. An unread config
 * counts as one.
 */
function pushesMore(config: string): boolean {
  if (!config) return true
  return config.split('\0').some(entry => {
    const end = entry.indexOf('\n')
    const key = (end < 0 ? entry : entry.slice(0, end)).toLowerCase()
    if (/^remote\..+\.(?:mirror|push)$/.test(key)) return true
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
      if (pushesMore(await gitIn($, folder, ['config', '--null', '--list']))) return true
    }
  }
  return false
}

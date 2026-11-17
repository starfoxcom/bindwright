import type { EngineInterface } from 'claude-code'

import { type GitStep, plainSteps } from './plain'

// Which branch a piece of work is on, so a step back holds only the red PR's work.

async function git($: EngineInterface, cwd: string, folder: string, args: readonly string[]) {
  try {
    const { stdout, exitCode } = await $.process.run(['git', '-C', folder, ...args], { cwd, timeoutMs: 10_000 })
    return exitCode === 0 ? stdout.trim() : ''
  } catch {
    return ''
  }
}

// What git reports in `folder` (relative to the shell's folder, which is the folder itself when undefined).
// The session's folder is the one the shell's last `cd` left it in, read again on every call.
async function gitIn($: EngineInterface, folder: string | undefined, args: readonly string[]) {
  const cwd = await $.session.cwd()
  return git($, cwd, folder ?? cwd, args)
}

// A push config that sends more than the checked-out branch: a mirror remote, a `remote.<name>.push`
// refspec or `push.default=matching`. A folder whose config cannot be read counts as one.
const PUSHES_MORE = /^(?:remote\..+\.(?:mirror|push)=|push\.default=matching$)/im

/** The folder holding the file an edit names, or undefined without a path. */
export function folderOf(e: unknown): string | undefined {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  if (typeof path !== 'string' || !/[\/]/.test(path)) return undefined
  return path.replace(/[\/][^\/]*$/, '') || undefined
}

/** The commits and pushes a command makes, each in its folder, or null when they cannot be read in full. */
export async function commandSteps(
  $: EngineInterface,
  command: string,
  isPowerShell: boolean,
): Promise<GitStep[] | null> {
  return plainSteps(command, (await $.env.get('OS')) === 'Windows_NT', isPowerShell)
}

/**
 * Whether the work may be on `branch`: it is checked out, or pushed to, in the folder of any of `steps`,
 * a push there may send it, or the command names it. Unread steps or an unread branch count as yes, so a
 * hold never lifts on a guess.
 */
export async function mayBeOn(
  $: EngineInterface,
  branch: string | undefined,
  steps: readonly GitStep[] | null,
  command = '',
): Promise<boolean> {
  if (!branch || !steps || command.includes(branch)) return true
  for (const { folder, isPush } of steps) {
    const name = await gitIn($, folder, ['branch', '--show-current'])
    if (!name || name === branch) return true
    const upstream = await gitIn($, folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    if (upstream.endsWith(`/${branch}`)) return true
    if (isPush) {
      const config = await gitIn($, folder, ['config', '--list'])
      if (!config || PUSHES_MORE.test(config)) return true
    }
  }
  return false
}

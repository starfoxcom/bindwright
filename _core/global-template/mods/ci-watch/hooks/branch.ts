import type { EngineInterface } from 'claude-code'

import { isPlainCommitOrPush, namedFolders } from './command'

// Which branch a piece of work is on, so a step back holds only the red PR's work.

async function git($: EngineInterface, cwd: string, folder: string, args: readonly string[]) {
  try {
    const { stdout, exitCode } = await $.process.run(['git', '-C', folder, ...args], { cwd, timeoutMs: 10_000 })
    return exitCode === 0 ? stdout.trim() : ''
  } catch {
    return ''
  }
}

// The branch checked out in `folder` (relative to the shell's folder, which is the folder itself when
// undefined) and the branch it pushes to, or undefined when no branch is checked out there.
async function checkedOut($: EngineInterface, folder?: string) {
  const cwd = await $.session.cwd()
  const name = await git($, cwd, folder ?? cwd, ['branch', '--show-current'])
  if (!name) return undefined
  const upstream = await git($, cwd, folder ?? cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return { name, upstream }
}

/** The folder holding the file an edit names, or undefined without a path. */
export function folderOf(e: unknown): string | undefined {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  if (typeof path !== 'string' || !/[\\/]/.test(path)) return undefined
  return path.replace(/[\\/][^\\/]*$/, '') || undefined
}

/**
 * The folders a commit or push acts in: the shell's own (undefined) and each one it moves git to, or null
 * for a command whose folders cannot be read in full, which may then act anywhere.
 */
export async function commandFolders(
  $: EngineInterface,
  command: string,
  isPowerShell: boolean,
): Promise<(string | undefined)[] | null> {
  if (!isPlainCommitOrPush(command, isPowerShell)) return null
  return [undefined, ...namedFolders(command, (await $.env.get('OS')) === 'Windows_NT', isPowerShell)]
}

/**
 * Whether the work may be on `branch`: it is checked out, or pushes to it, in any of `folders`, or the
 * command names it. An unread branch or folder list counts as yes, so a hold never lifts on a guess.
 */
export async function mayBeOn(
  $: EngineInterface,
  branch: string | undefined,
  folders: readonly (string | undefined)[] | null,
  command = '',
): Promise<boolean> {
  if (!branch || !folders || command.includes(branch)) return true
  for (const folder of folders) {
    const here = await checkedOut($, folder)
    if (!here || here.name === branch || here.upstream.endsWith(`/${branch}`)) return true
  }
  return false
}

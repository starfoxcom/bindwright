import type { EngineInterface } from 'claude-code'

import { namedFolders } from './command'

// Which branch a piece of work is on, so a step back holds only the red PR's work.

// The branch checked out in `folder` (the session's folder without one); undefined outside a repo or on a
// detached head.
async function checkedOut($: EngineInterface, folder?: string): Promise<string | undefined> {
  try {
    const args = ['git', ...(folder ? ['-C', folder] : []), 'branch', '--show-current']
    const { stdout, exitCode } = await $.process.run(args, { timeoutMs: 10_000 })
    return exitCode === 0 && stdout.trim() ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** The folder holding the file an edit names, or undefined without a path. */
export function folderOf(e: unknown): string | undefined {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  if (typeof path !== 'string' || !/[\\/]/.test(path)) return undefined
  return path.replace(/[\\/][^\\/]*$/, '') || undefined
}

/** The folders a commit or push may act in: the session's own (undefined) and each one it moves git to. */
export async function commandFolders(
  $: EngineInterface,
  command: string,
  isPowerShell: boolean,
): Promise<(string | undefined)[]> {
  return [undefined, ...namedFolders(command, (await $.env.get('OS')) === 'Windows_NT', isPowerShell)]
}

/**
 * Whether the work may be on `branch`: it is checked out in any of `folders`, or the command names it.
 * A branch that cannot be read counts as yes, so a hold never lifts on a failed lookup.
 */
export async function mayBeOn(
  $: EngineInterface,
  branch: string | undefined,
  folders: readonly (string | undefined)[],
  command = '',
): Promise<boolean> {
  if (!branch || command.includes(branch)) return true
  for (const folder of folders) {
    const here = await checkedOut($, folder)
    if (!here || here === branch) return true
  }
  return false
}

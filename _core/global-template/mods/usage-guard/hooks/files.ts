import type { EngineInterface } from 'claude-code'

import type { Pause } from './plan'

// The mod's data folder and the shared pause file, read and written the same way by every part of the mod.

let dir: string | undefined

export async function dataDir($: EngineInterface): Promise<string> {
  if (dir) return dir
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return (dir = `${configured ?? `${home}/.claude`}/mods-data/usage-guard`.replace(/\\/g, '/'))
}

export async function pausePath($: EngineInterface): Promise<string> {
  return `${await dataDir($)}/pause.json`
}

/** One of this mod's JSON files, or undefined when it is missing or unreadable. */
export async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(String(await $.fs.read(path))) as T
  } catch {
    return undefined
  }
}

export async function readPause($: EngineInterface): Promise<Pause | undefined> {
  return readJson<Pause>($, await pausePath($))
}

export async function writePause($: EngineInterface, pause: Pause): Promise<void> {
  await $.fs.write(await pausePath($), JSON.stringify(pause, null, 2))
}

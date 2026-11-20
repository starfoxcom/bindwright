import type { EngineInterface } from 'claude-code'

import type { Fence, Pause } from './plan'
import { givenDir } from './settings'

// The mod's data folder and the shared pause file, read and written the same way by every part of the mod.

let dir: string | undefined

export async function dataDir($: EngineInterface): Promise<string> {
  if (dir) return dir
  const configured = givenDir(await $.env.get('CLAUDE_CONFIG_DIR'))
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

/** The early-reset fence (see `Fence`): its own file, so a later pause written over the pause file keeps it. */
export async function readFence($: EngineInterface): Promise<Fence> {
  return (await readJson<Fence>($, `${await dataDir($)}/fence.json`)) ?? {}
}

/**
 * A switch that ended a pause on an account spent that pause's claims, whatever pause the pause file holds by the
 * time the account runs hot again: a pause planned there whose key would be `key` (the ended pause's own) is named
 * with `episode`. Any other window, or kind of window, keeps a key of its own.
 */
export type EndedBySwitch = { episode: string; key: string }

/** Per account id, the newest pause a switch ended there. */
export async function readEpisodes($: EngineInterface): Promise<Record<string, EndedBySwitch>> {
  const file = await readJson<Record<string, Partial<EndedBySwitch>>>($, `${await dataDir($)}/episodes.json`)
  const episodes: Record<string, EndedBySwitch> = {}
  for (const [account, { episode, key } = {}] of Object.entries(file ?? {})) {
    if (typeof episode === 'string' && typeof key === 'string') episodes[account] = { episode, key }
  }
  return episodes
}

export async function writeEpisode($: EngineInterface, account: string, ended: EndedBySwitch): Promise<void> {
  const episodes = { ...(await readEpisodes($)), [account]: ended }
  await $.fs.write(`${await dataDir($)}/episodes.json`, JSON.stringify(episodes, null, 2))
}

export async function writeFence($: EngineInterface, fence: Fence): Promise<void> {
  await $.fs.write(`${await dataDir($)}/fence.json`, JSON.stringify(fence, null, 2))
}

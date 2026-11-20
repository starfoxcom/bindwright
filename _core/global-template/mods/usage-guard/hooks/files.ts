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
 * Per account id, the episode its next pause is named with. A switch that ends a pause on an account starts a new
 * one there: that pause's claims are spent, whatever pause the pause file holds by the time the account runs hot again.
 */
export async function readEpisodes($: EngineInterface): Promise<Record<string, string>> {
  return (await readJson<Record<string, string>>($, `${await dataDir($)}/episodes.json`)) ?? {}
}

export async function writeEpisode($: EngineInterface, account: string, episode: string): Promise<void> {
  const episodes = { ...(await readEpisodes($)), [account]: episode }
  await $.fs.write(`${await dataDir($)}/episodes.json`, JSON.stringify(episodes, null, 2))
}

export async function writeFence($: EngineInterface, fence: Fence): Promise<void> {
  await $.fs.write(`${await dataDir($)}/fence.json`, JSON.stringify(fence, null, 2))
}

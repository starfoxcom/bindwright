// Where ci-watch keeps its files, and each PR's fix rounds, shared by every session.
import type { EngineInterface } from 'claude-code'
import type { Watch } from '../types'
import { isResearchDue, recordRound, redStreak, ROUNDS_FILE } from './rounds'
import type { PrRounds } from './rounds'

// The engine's fs makes no missing folders, so the data folder is made through node, once per load.
export const MKDIR_SCRIPT = 'require("fs").mkdirSync(process.argv[1],{recursive:true})'
const madeDirs = new Set<string>()
export async function ensureDir($: EngineInterface, dir: string): Promise<void> {
  if (madeDirs.has(dir)) return
  const { exitCode } = await $.process.run(['node', '-e', MKDIR_SCRIPT, dir], { timeoutMs: 10_000 })
  if (exitCode === 0) madeDirs.add(dir)
}

export async function statePath($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const dir = `${configured ?? `${home}/.claude`}/mods-data/ci-watch`
  return `${dir}/${await $.session.id()}.json`.replaceAll('\\', '/')
}

export async function dataFolder($: EngineInterface): Promise<string> {
  return (await statePath($)).replace(/\/[^/]*$/, '')
}

// The fix-round count (rounds.ts). Each PR's rounds live beside the session files, shared by every session.
async function roundsPath($: EngineInterface): Promise<string> {
  const path = await statePath($)
  return `${path.slice(0, path.lastIndexOf('/'))}/${ROUNDS_FILE}`
}

export async function readRounds($: EngineInterface): Promise<Record<string, PrRounds>> {
  const all = await $.fs.read(await roundsPath($)).then(text => JSON.parse(String(text))).catch(() => undefined)
  return all && typeof all === 'object' ? (all as Record<string, PrRounds>) : {}
}

// The PR's rounds changed by `change`, applied to the file as read right before the write, with nothing
// awaited between the two: a round another session wrote meanwhile is the state the change starts from.
async function updateRounds($: EngineInterface, key: string, change: (pr?: PrRounds) => PrRounds) {
  const path = await roundsPath($)
  await ensureDir($, path.slice(0, path.lastIndexOf('/')))
  const all = await readRounds($)
  await $.fs.write(path, JSON.stringify({ ...all, [key]: change(all[key]) }))
}

// Each watch that settled on a pushed head is one round: red when a check failed. A watch that ran out of
// time says nothing about the checks and is no round. A failed write leaves the count as it was. Returns
// the PRs, as `owner/name#N`, whose red round asks for a step back.
export async function recordRounds($: EngineInterface, settled: readonly Watch[]): Promise<Set<string>> {
  const stepBacks = new Set<string>()
  for (const w of settled) {
    // A silent watch follows a head someone else pushed: no round of this session's.
    if (w.isSilent || (w.outcome !== 'failed' && w.outcome !== 'passed')) continue
    const red = w.outcome === 'failed'
    const key = `${w.repo}#${w.number}`
    const counted = (pr?: PrRounds) => {
      const next = recordRound(pr, w.headSha, red)
      if (red && isResearchDue(redStreak(next))) stepBacks.add(key)
      return next
    }
    await updateRounds($, key, counted).catch(() => stepBacks.delete(key))
  }
  return stepBacks
}

export async function redRoundsOf($: EngineInterface, pr: { repo: string; number: number }): Promise<number> {
  return redStreak((await readRounds($))[`${pr.repo}#${pr.number}`])
}

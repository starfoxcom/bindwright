import type { EngineInterface, SessionRateLimit } from 'claude-code'

import type { Pause } from './plan'
import { givenDir } from './settings'

// Which account this computer is signed in with. Claude Code keeps the login in its global config
// (`~/.claude.json`, `oauthAccount`), and a /login in any session changes it for every session.

/** The signed-in account: its id, and the plan name the texts show. */
export type Account = { id: string; label: string }

type Login = {
  accountUuid?: unknown
  planDisplayName?: unknown
  organizationType?: unknown
  organizationRateLimitTier?: unknown
}

/** The account a global config names, or undefined when it names none or does not parse. */
export function accountOf(text: string): Account | undefined {
  try {
    const login = (JSON.parse(text) as { oauthAccount?: Login }).oauthAccount
    if (!login || typeof login.accountUuid !== 'string' || !login.accountUuid) return undefined
    return { id: login.accountUuid, label: planLabel(login) }
  } catch {
    return undefined
  }
}

/** The plan as the login names it, or read from its type and tier (`claude_max`, `..._max_5x`: "Max 5x"). */
export function planLabel(login: Login): string {
  if (typeof login.planDisplayName === 'string' && login.planDisplayName) return login.planDisplayName
  const type = typeof login.organizationType === 'string' ? login.organizationType.replace(/^claude_/, '') : ''
  const rateTier = login.organizationRateLimitTier
  const tier = typeof rateTier === 'string' ? /_(\d+x)$/.exec(rateTier) : null
  const name = type ? `${type[0]?.toUpperCase()}${type.slice(1)}` : 'Claude'
  return tier ? `${name} ${tier[1]}` : name
}

export async function readAccount($: EngineInterface): Promise<Account | undefined> {
  const configured = givenDir(await $.env.get('CLAUDE_CONFIG_DIR'))
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const file = (configured ? `${configured}/.claude.json` : `${home}/.claude.json`).replace(/\\/g, '/')
  return accountOf(String(await $.fs.read(file).catch(() => '')))
}

/**
 * A live pause made on another account, now that this session's own readings come from the account signed in
 * and every limit the pause covers reads under the wrap-up line there: the switch left room, so the pause ends.
 */
export function isLiftedBySwitch(
  pause: Pause,
  account: Account | undefined,
  limits: readonly SessionRateLimit[],
  s: { wrapUpAt: number; isFresh: boolean; now: number },
): boolean {
  const isLive = pause.status === 'active' && pause.wakeAt > s.now
  if (!isLive || !pause.account || !account || account.id === pause.account || !s.isFresh) return false
  const isClear = (kind: string) => {
    const limit = limits.find(item => item.kind === kind)
    return limit !== undefined && limit.percentUsed < s.wrapUpAt
  }
  return pause.kinds.length > 0 && pause.kinds.every(isClear)
}

/** The card a session holding an arm set by hand shows after a switch. */
export function switchCardText(label: string, wakeText: string): string {
  return (
    `Signed in with another account (${label}). Arms a pause set lift by themselves, but this session's resume ` +
    `at ${wakeText} was set by hand, so it waits until you lift it.`
  )
}

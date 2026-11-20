import type { EngineInterface } from 'claude-code'

import { givenDir } from './settings'

// Which account this session runs on. Claude Code keeps the login in its global config (`~/.claude.json`,
// `oauthAccount`), and a /login in any session changes that record for every session. Running sessions read the
// changed credentials again (at their next request on Windows and Linux, within about 30 seconds from the macOS
// keychain), so the record names the account every session runs on.

/** A signed-in account: its id, and the plan name the line shows (never an email). */
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

// The plan as the login names it, or read from its type and tier (`claude_max`, `..._max_5x`: "Max 5x").
function planLabel(login: Login): string {
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
 * The account to show after one more look at the login record, and whether it differs from the one this session
 * showed before. A missing record changes nothing.
 */
export function nextAccount(
  shown: Account | undefined,
  onRecord: Account | undefined,
): { account: Account | undefined; isSwitched: boolean } {
  if (!onRecord) return { account: shown, isSwitched: false }
  return { account: onRecord, isSwitched: shown !== undefined && shown.id !== onRecord.id }
}

/** The facts line's account field, and the one-time note on the look that sees a switch. */
export function accountText(account: Account | undefined, isSwitched: boolean): string {
  if (!account) return ''
  return isSwitched ? ` | account ${account.label} | switched to ${account.label}` : ` | account ${account.label}`
}

import type { EngineInterface, SessionRateLimit } from 'claude-code'

import { givenDir } from './settings'

// Which account this session runs on. Claude Code keeps the login in its global config (`~/.claude.json`,
// `oauthAccount`), and a /login in any session changes that record for every session. A session that was already
// running proves it runs on the new account only once its own plan figures move.

/** A signed-in account: its id, and the plan name the line shows (never an email). */
export type Account = { id: string; label: string }

/** What this session knows of the login: the account, and the figures it had when the record named a new one. */
export type AccountView = { account: Account; isConfirmed: boolean; figuresAtSwitch?: string }

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

/** The figures that change when a session's requests run on another account: each plan window's reset time. */
export function figuresKey(limits: readonly SessionRateLimit[]): string {
  return limits
    .map(limit => `${limit.kind}@${limit.resetsAt ?? ''}`)
    .sort()
    .join(',')
}

/**
 * The view after one more look at the login record and this session's figures. The first account a session sees
 * is the one it runs on. A new one on record is unconfirmed until the figures move off the ones the session had
 * when the record changed; `isSwitched` is true on the one look that confirms it. A missing record changes nothing.
 */
export function nextView(
  view: AccountView | undefined,
  account: Account | undefined,
  figures: string,
): { view: AccountView | undefined; isSwitched: boolean } {
  if (!account) return { view, isSwitched: false }
  if (!view) return { view: { account, isConfirmed: true }, isSwitched: false }
  if (account.id !== view.account.id) {
    return { view: { account, isConfirmed: false, figuresAtSwitch: figures }, isSwitched: false }
  }
  if (!view.isConfirmed && figures !== view.figuresAtSwitch) {
    return { view: { account, isConfirmed: true }, isSwitched: true }
  }
  return { view: { ...view, account }, isSwitched: false }
}

/** The facts line's account field, and the one-time note when a switch is confirmed. */
export function accountText(view: AccountView | undefined, isSwitched: boolean): string {
  if (!view) return ''
  const field = ` | account ${view.account.label}${view.isConfirmed ? '' : ', not confirmed yet'}`
  return isSwitched ? `${field} | switched to ${view.account.label}` : field
}

import type { EngineInterface, SessionRateLimit } from 'claude-code'

import { givenDir } from './settings'

// Which account this session runs on. Claude Code keeps the login in its global config (`~/.claude.json`,
// `oauthAccount`), and a /login in any session changes that record for every session. A session that was already
// running proves it runs on the new account only once its own plan figures move.

/** A signed-in account: its id, and the plan name the line shows (never an email). */
export type Account = { id: string; label: string }

/** Each plan window's reset time, by kind. */
export type Figures = Record<string, string>

/**
 * What this session knows of the login: the account on record, the one its own figures last showed it runs on,
 * and, while those differ, the figures it had when the record changed (none until it has any).
 */
export type AccountView = { onRecord: Account; confirmed: Account; figuresAtSwitch?: Figures }

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

/** The reset time of each plan window the session reports, or undefined while it reports none. */
export function figuresOf(limits: readonly SessionRateLimit[]): Figures | undefined {
  const figures: Figures = {}
  for (const limit of limits) if (limit.resetsAt) figures[limit.kind] = limit.resetsAt
  return Object.keys(figures).length > 0 ? figures : undefined
}

// Proof of another account: a window both readings report moved to another reset before the old one came due.
// A window past its reset rolls over on the same account, so it proves nothing.
function isMovedOff(before: Figures, after: Figures, now: number): boolean {
  return Object.keys(before).some(kind => {
    const was = before[kind] ?? ''
    return after[kind] !== undefined && after[kind] !== was && Date.parse(was) > now
  })
}

// A window of the baseline came due: a rollover from here on proves nothing, so the comparison starts over.
function isStale(before: Figures, now: number): boolean {
  return Object.values(before).some(resetsAt => !(Date.parse(resetsAt) > now))
}

/**
 * The view after one more look at the login record and this session's figures. The first account a session sees
 * is the one it runs on. Another one on record stays unconfirmed until the figures move off the ones the session
 * had when the record changed; `isSwitched` is true on the one look that confirms it. The confirmed account back on
 * record is no switch, and a missing record changes nothing.
 */
export function nextView(
  view: AccountView | undefined,
  account: Account | undefined,
  figures: Figures | undefined,
  now: number,
): { view: AccountView | undefined; isSwitched: boolean } {
  if (!account) return { view, isSwitched: false }
  const settled = { onRecord: account, confirmed: account }
  if (!view || account.id === view.confirmed.id) return { view: settled, isSwitched: false }
  const before = view.onRecord.id === account.id ? view.figuresAtSwitch : undefined
  if (before && figures && isMovedOff(before, figures, now)) return { view: settled, isSwitched: true }
  const baseline = before && !isStale(before, now) ? before : figures
  return { view: { onRecord: account, confirmed: view.confirmed, figuresAtSwitch: baseline }, isSwitched: false }
}

/** The facts line's account field, and the one-time note when a switch is confirmed. */
export function accountText(view: AccountView | undefined, isSwitched: boolean): string {
  if (!view) return ''
  const label = view.onRecord.label
  const field = ` | account ${label}${view.onRecord.id === view.confirmed.id ? '' : ', not confirmed yet'}`
  return isSwitched ? `${field} | switched to ${label}` : field
}

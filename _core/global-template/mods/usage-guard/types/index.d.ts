/**
 * The card every session draws above the prompt while a usage event matters: the pause, the
 * automatic resume, a cancelled resume. It lives in `mods-data/usage-guard/card.json`, so one
 * Dismiss clears it in every session. Claude Code's own toast vanishes after a few seconds.
 */
export type UsageCard = {
  /** Event key, e.g. `paused:<resetsAt>`; a card with the same id is never written twice. */
  id: string
  text: string
  dismissed: boolean
}

export type UsageGuardBand = {
  card: UsageCard | null
  /** True while the pause is on and its automatic resume can still be cancelled. */
  canCancel: boolean
  /** This session holds an arm, so the card can cancel its resume alone. */
  canDisarmHere?: boolean
}

/** The settings pane's own state: the last refusal per field, shown under that field. */
export type SettingsView = {
  errors: Record<string, string>
  /** A change saved on a surface whose /config lists no plugin rows, where the field cannot show it. */
  saved?: Record<string, string>
}

/**
 * A wake that resumes this session's work after a reset or at a time of day, armed by hand
 * (`/usage-guard arm 5h|week|HH:MM`, or the `arm` tool). Kept in state so a hot reload (a settings
 * change, an edit) re-arms it.
 */
export type ArmedWake = {
  /** When it was set, in ms: a disarm of every session drops the arms set before it. */
  setAt?: number
  /** The limit's kind, `five_hour` or `seven_day`, or `clock` for a time of day. */
  kind: string
  /** For a reset, its time; for a time of day, the wake's own (the claims are keyed on it). */
  resetsAt: string
  wakeAt: number
  /** Armed with nothing pending: the card above the prompt asks to keep or cancel it, until answered. */
  isQuestioned?: boolean
  /** The session id the arm was set in: its task list still counts at the wake after a /clear. */
  armedIn?: string
  /** The session id the arm's saved copy is filed under; a /clear moves it to the new one. */
  session?: string
  /** The project folder the arm was set in: a later session there is offered an arm that never ran. */
  root?: string
  /** What the wake is for, as the person quoted it: handed to the session it wakes. */
  reason?: string
  /** Lifted, or held after a switch: it fires apart from its reset's own wake, so its claim names its wake time. */
  isOffReset?: boolean
}

/** This session's own resume at a pause's wake (hooks/pausearm.ts), kept apart from the arm set by hand. */
export type PauseArm = {
  /** The pause's reset key (`resetKey`): an extended pause keeps it. */
  key: string
  resetsAt: string
  wakeAt: number
  /** When it was set, in ms: a disarm of every session after it declines it. */
  setAt: number
  /** The session saved work at the wrap-up, so its wake resumes something. */
  hasWork?: boolean
  /** The person cancelled this session's resume: the pause never arms it again. */
  isDeclined?: boolean
  /** The session id it was first filed under, which its saved work is filed under too: a /clear does not change it. */
  session?: string
}

/** Another session's arm in this project whose wake passed while that session was closed. */
export type AdoptOffer = {
  /** The session id the arm is filed under. */
  owner: string
  arm: ArmedWake
}

/**
 * The work a session saved at a pause's wrap-up, filed inside its `work-<reset>-<session>` claim folder
 * so a later session in the project can offer it if that session is closed when the reset comes.
 */
export type SavedWork = {
  session: string
  /** The project folder the session ran in. */
  root: string
  /** The pause's reset key (`resetKey`): the claims of that pause are named with it. */
  key: string
  resetsAt: string
  wakeAt: number
  kinds?: string[]
  /** The person kept the work for this session: opened again, it resumes it by itself. */
  isKept?: boolean
}

/** Saved work a closed session never resumed, offered here. */
export type SavedOffer = {
  record: SavedWork
  /** When it came due: the pause's wake. */
  dueAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-guard': {
      band: UsageGuardBand | null
      settings: SettingsView | null
      armed: ArmedWake | null
      pauseArm: PauseArm | null
      /** The account this session's plan readings came from (at its last turn's end), and the card about an arm
       * set by hand that a switch held back, until answered. */
      account: {
        reading: string | null
        card: { label: string; wakeAt: number } | null
      } | null
      /** What the last press on the arm card did, shown in its place until dismissed. */
      armNote: string | null
      /** A closed session's arm that never ran, or its saved work, offered here; then what the press did. */
      adopt: {
        offer: AdoptOffer | null
        saved?: SavedOffer | null
        text: string | null
        note: string | null
      } | null
    }
  }
}

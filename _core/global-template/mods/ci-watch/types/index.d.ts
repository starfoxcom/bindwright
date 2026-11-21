// One watched PR, saved per session and drawn by view.tsx above the prompt.
export type Watch = {
  repo: string
  number: number
  headSha: string
  startedAt: number
  checks: Record<string, string>
  stablePolls: number
  // When the checks last went quiet; unset while any runs.
  quietSince?: number
  outcome?: 'passed' | 'failed' | 'timeout'
  settledAt?: number
  /** Set when the watch starts; names its wake claim (see `claimWake`). */
  id?: string
  /** When this session last pushed to the PR or asked to watch it: a new head within the hour is its own. */
  pushedAt?: number
  /** Restarted on a head someone else pushed: it keeps the row current and wakes no session. */
  isSilent?: boolean
  /** Settled, its wake not sent yet: it goes out once no turn runs. Saved, so a reload sends it. */
  wakePending?: boolean
  /** An open GitHub incident touching Actions while this watch's checks sat pending; its name. */
  incident?: string
  /**
   * The incident's note, not sent yet. Its own flag: `wakePending` is only ever set on a settled watch, and
   * every path that keeps or drops a wake relies on that. Dropped once the watch settles or its head moves.
   */
  incidentPending?: boolean
  /** Whether GitHub lists any workflow for the repo, asked once the PR has gone a while with no check. */
  hasWorkflows?: boolean
  /**
   * Set by the red wake that asks for a step back: the distinct topics looked up on the web since. While set,
   * the session's edits, commits and pushes wait; it clears at `stepBackNeeded` topics, a green round or
   * `/ci-watch stop`.
   */
  stepBackTopics?: string[]
  /** The distinct lookups the latched step back takes, fixed when it latched: three, or five near the hard stop. */
  stepBackNeeded?: number
}

/** A background run (a shell or a subagent) this session started and has not heard back from. */
export type Run = {
  id: string
  label: string
  /** Where the engine writes the run's output. */
  file: string
  /** The largest output size seen so far; -1 until the file is first readable. */
  size: number
  /** When the output last grew, or when the run started. */
  grewAt: number
  /** Set once it went quiet, so it wakes the session only once. */
  isReported?: boolean
  /** Its quiet wake is due and not sent yet. Saved, so a reload sends it. */
  isWakePending?: boolean
  /** How many sends of its wake were refused. */
  wakeTries?: number
}

/** The settings pane's own state: the last refusal per field. */
export type SettingsView = { errors: Record<string, string>; saved?: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    'ci-watch': { watches: Watch[]; expanded: string[]; settings: SettingsView | null; runs: Run[] }
  }
}

import { RESEARCH_EVERY } from './rounds'

/** The /ci-watch argument hint and its help text. */
export const HINT = '[help | settings | set | stop | phone | rounds]'
export const HELP = [
  "/ci-watch: watches a PR's checks and wakes the session once when they settle.",
  '  /ci-watch           the watched PRs and their checks',
  '  /ci-watch stop      stop watching every PR in this session',
  '  /ci-watch settings  open the settings pane',
  '  /ci-watch set       change a setting: set <name> <value>; alone, list them',
  '  /ci-watch phone     the same as text, for phone chats',
  `  /ci-watch rounds    the fix rounds in a row without green checks on this branch's PR (or rounds <pr>,`,
  `                      a number or owner/name#N); every ${RESEARCH_EVERY}, the red wake asks for a step back`,
  '  /ci-watch help      this list',
].join('\n')

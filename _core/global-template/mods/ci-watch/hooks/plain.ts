import { fromGitBash } from './command'

// A commit or push read word by word under a grammar both shells read the same way, so what it names is
// all it does: bare words of path characters, whole quoted words holding plain ASCII with nothing that
// expands or escapes, and steps joined by `&&`, `;` or newlines. A command outside the grammar is not
// plain: it may hide a `cd`, a `git -C` or a branch move the reader cannot see.

/** One `git commit` or `git push` step: the folder it acts in (undefined for the shell's own). */
export type GitStep = { folder?: string; isPush?: boolean }

type Word = { text: string; isQuoted: boolean }

const SEPARATOR = /[ \t\r]*(?:&&|;|\n)/y
// A word ends at a blank, a separator or the end, so a quote glued to more text is no word.
const WORD_END = String.raw`(?=[ \t\r;\n]|&&|$)`
// Printable ASCII without the single quote; without the double quote, `$`, `\` and the backtick.
const SINGLE_QUOTED = String.raw`'([\x20-\x26\x28-\x7e]*)'`
const DOUBLE_QUOTED = String.raw`"([\x20\x21\x23\x25-\x5b\x5d-\x5f\x61-\x7e]*)"`
// A backslash is a path character in PowerShell and an escape in Bash.
const BARE = { bash: String.raw`([\w./:=-]+)`, powershell: String.raw`([\w./:=\\-]+)` }
const word = (isPowerShell: boolean) => {
  const bare = BARE[isPowerShell ? 'powershell' : 'bash']
  return new RegExp(String.raw`[ \t\r]*(?:${SINGLE_QUOTED}|${DOUBLE_QUOTED}|${bare})${WORD_END}`, 'y')
}

const PUSH_OPTION = /^(?:-[quv]+|--(?:quiet|verbose|set-upstream))$/
const PUSH_NAME = /^\w[\w./-]*$/
const ABSOLUTE = /^(?:[a-zA-Z]:|[/\\])/

// The command's steps as words, or null when any part of it falls outside the grammar.
function stepsOf(command: string, isPowerShell: boolean): Word[][] | null {
  const steps: Word[][] = [[]]
  const words = word(isPowerShell)
  let at = 0
  while (at < command.length) {
    SEPARATOR.lastIndex = at
    words.lastIndex = at
    const separator = SEPARATOR.exec(command)
    const found = separator ? null : words.exec(command)
    if (separator) {
      steps.push([])
      at = SEPARATOR.lastIndex
    } else if (found) {
      const quoted = found[1] ?? found[2]
      steps.at(-1)!.push({ text: quoted ?? found[3]!, isQuoted: quoted !== undefined })
      at = words.lastIndex
    } else if (/^[ \t\r]*$/.test(command.slice(at))) {
      break
    } else {
      return null
    }
  }
  return steps.filter(step => step.length > 0)
}

const isBare = (w: Word | undefined, text: string) => w !== undefined && !w.isQuoted && w.text === text
const moveTo = (here: string | undefined, path: string) =>
  here === undefined || ABSOLUTE.test(path) ? path : `${here}/${path}`

// A `git [-C <dir>] commit|push` step run from `here`, or null for any other step. A push takes only a few
// options and plain names, never a refspec with a colon, a glob or a quote.
function gitStep(step: Word[], here: string | undefined, isWindows: boolean): GitStep | null {
  if (!isBare(step[0], 'git')) return null
  const hasFolder = isBare(step[1], '-C') && step[2] !== undefined
  const folder = hasFolder ? moveTo(here, fromGitBash(step[2]!.text, isWindows)) : here
  const verb = step[hasFolder ? 3 : 1]
  const args = step.slice(hasFolder ? 4 : 2)
  if (isBare(verb, 'commit')) return { folder }
  if (!isBare(verb, 'push')) return null
  const isPlain = args.every(a => !a.isQuoted && (PUSH_OPTION.test(a.text) || PUSH_NAME.test(a.text)))
  return isPlain ? { folder, isPush: true } : null
}

/**
 * The commits and pushes of a plain command, each with the folder it acts in: steps that are each a
 * `cd <dir>` or a `git [-C <dir>] commit|push`. Null for anything else, which may act anywhere.
 */
export function plainSteps(command: string, isWindows: boolean, isPowerShell = false): GitStep[] | null {
  const steps = stepsOf(command, isPowerShell)
  if (!steps) return null
  const work: GitStep[] = []
  let here: string | undefined
  for (const step of steps) {
    const target = step[1]
    if (isBare(step[0], 'cd') && step.length === 2 && !target!.text.startsWith('-')) {
      here = moveTo(here, fromGitBash(target!.text, isWindows))
      continue
    }
    const git = gitStep(step, here, isWindows)
    if (!git) return null
    work.push(git)
  }
  return work.length > 0 ? work : null
}

// A Bash commit or push read word by word under a grammar small enough that the shell reads it the same
// way: bare words of path characters, whole quoted words holding plain ASCII with nothing that expands
// or escapes, and steps joined by `&&`, `;` or newlines, each a `git commit` or `git push` with no folder
// of its own. It acts in the shell's folder, so no path is ever worked out from the text. Anything outside
// the grammar is not plain: it may act in another folder or on another branch.

type Word = { text: string; isQuoted: boolean }

const SEPARATOR = /[ \t]*(?:&&|;|\n)/y
// A word ends at a blank, a separator or the end, so a quote glued to more text is no word.
const WORD_END = String.raw`(?=[ \t;\n]|&&|$)`
// Printable ASCII without the single quote; without the double quote, `$`, `\` and the backtick.
const SINGLE_QUOTED = String.raw`'([\x20-\x26\x28-\x7e]*)'`
const DOUBLE_QUOTED = String.raw`"([\x20\x21\x23\x25-\x5b\x5d-\x5f\x61-\x7e]*)"`
const WORD = new RegExp(String.raw`[ \t]*(?:${SINGLE_QUOTED}|${DOUBLE_QUOTED}|([\w./:=-]+))${WORD_END}`, 'y')

const PUSH_OPTION = /^(?:-[quv]+|--(?:quiet|verbose|set-upstream))$/
const PUSH_NAME = /^\w[\w./-]*$/

// The command's steps as words, or null when any part of it falls outside the grammar.
function stepsOf(command: string): Word[][] | null {
  const steps: Word[][] = [[]]
  let at = 0
  while (at < command.length) {
    SEPARATOR.lastIndex = at
    WORD.lastIndex = at
    const separator = SEPARATOR.exec(command)
    const found = separator ? null : WORD.exec(command)
    if (separator) {
      steps.push([])
      at = SEPARATOR.lastIndex
    } else if (found) {
      const quoted = found[1] ?? found[2]
      steps.at(-1)!.push({ text: quoted ?? found[3]!, isQuoted: quoted !== undefined })
      at = WORD.lastIndex
    } else if (/^[ \t]*$/.test(command.slice(at))) {
      break
    } else {
      return null
    }
  }
  return steps.filter(step => step.length > 0)
}

const isBare = (w: Word | undefined, text: string) => w !== undefined && !w.isQuoted && w.text === text

// A push takes only a few options and plain names: never a refspec with a colon, a glob or a quote.
function isPlainStep([git, verb, ...args]: Word[]): boolean {
  if (!isBare(git, 'git')) return false
  if (isBare(verb, 'commit')) return true
  return isBare(verb, 'push') && args.every(a => !a.isQuoted && (PUSH_OPTION.test(a.text) || PUSH_NAME.test(a.text)))
}

/**
 * For a plain Bash command, whether it pushes (false for commits only); null for any other command, whose
 * folder or branch cannot be read from it.
 */
export function plainPush(command: string): boolean | null {
  const steps = stepsOf(command)
  if (!steps || steps.length === 0 || !steps.every(isPlainStep)) return null
  return steps.some(step => isBare(step[1], 'push'))
}

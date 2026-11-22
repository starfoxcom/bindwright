// A shell command at full length with everything that is not a command hidden: the inside of each
// quoted string, here-doc and here-string bodies, comments and arithmetic. A pattern that matches it sits
// at the same place in the command, and message text matches nothing. The ci-watch and tasks mods each
// carry this file; keep the two copies the same.

type Shell = 'bash' | 'powershell'
// What the reader is inside: a quote (Bash's `$'` too), a PowerShell here-string, a `$(...)` within a
// quote, or `((...))` arithmetic. Each open parenthesis inside the last two adds a frame.
type Frame = "'" | '"' | "$'" | "@'" | '@"' | 'sub' | 'arith'
type Reader = { frames: Frame[]; hereDocs: string[]; shell: Shell }
// How a step's text shows: as it is, hidden, as spaces, or as an escape (kept, the escaped one hidden).
type Shown = 'kept' | 'hidden' | 'blank' | 'escape'
type Step = [length: number, shown: Shown]

// `<<` alone (`<<<` feeds one word), its delimiter bare, quoted, or behind a backslash (`<<\EOF`).
const HERE_DOC = /^<<(?!<)-?\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][\w.-]*))/
const innermost = (reader: Reader) => reader.frames.at(-1)
const hide = (text: string) => '_'.repeat(text.length)

// A Bash quote, arithmetic or here-doc starting here, or one plain character.
function bashStep(line: string, i: number, reader: Reader): Step {
  const rest = line.slice(i)
  const doc = line[i - 1] === '<' ? null : HERE_DOC.exec(rest)
  if (doc) {
    reader.hereDocs.push(doc[1] ?? doc[2] ?? doc[3] ?? '')
    return [doc[0].length, 'kept']
  }
  const opener = /^(?:\$\(\(|\(\(|\$'|'|")/.exec(rest)?.[0]
  if (!opener) return [1, 'kept']
  if (opener.endsWith('((')) reader.frames.push('arith', 'arith')
  else reader.frames.push(opener as Frame)
  return [opener.length, 'kept']
}

// A PowerShell quote or here-string (`@'` or `@"` ending its line) starting here, or one plain character.
function powerShellStep(line: string, i: number, reader: Reader): Step {
  const rest = line.slice(i)
  const hereString = /^@(['"])\s*$/.exec(rest)
  if (hereString) {
    reader.frames.push(`@${hereString[1]}` as Frame)
    return [rest.length, 'kept']
  }
  if (rest[0] !== "'" && rest[0] !== '"') return [1, 'kept']
  reader.frames.push(rest[0])
  return [1, 'kept']
}

// One step where commands are read: outside quotes, or inside a `$(...)` within a quote.
function codeStep(line: string, i: number, reader: Reader): Step {
  const c = line[i] ?? ''
  if (c === (reader.shell === 'bash' ? '\\' : '`')) return [2, 'escape']
  if (c === '#' && (i === 0 || /[\s;&|(]/.test(line[i - 1] ?? ''))) return [line.length - i, 'blank']
  // `((` is arithmetic here too, so it is read before a `(` counts as a nested parenthesis.
  const isArithmetic = reader.shell === 'bash' && line.startsWith('((', i)
  if (innermost(reader) === 'sub' && !isArithmetic && (c === '(' || c === ')')) {
    if (c === '(') reader.frames.push('sub')
    else reader.frames.pop()
    return [1, 'kept']
  }
  return reader.shell === 'bash' ? bashStep(line, i, reader) : powerShellStep(line, i, reader)
}

// One step inside a here-string: its body runs to a line that starts with its closing mark.
function hereStringStep(line: string, i: number, reader: Reader, frame: Frame): Step {
  const close = `${frame[1]}@`
  if (i > 0 || !line.startsWith(close)) return [line.length - i, 'hidden']
  reader.frames.pop()
  return [close.length, 'hidden']
}

// One step inside a quote or arithmetic: each shell's own escape, the closing mark, or a `$(...)` that
// reads commands again until its closing parenthesis.
function quotedStep(line: string, i: number, reader: Reader): Step {
  const c = line[i] ?? ''
  const frame = innermost(reader) ?? "'"
  if (frame === "@'" || frame === '@"') return hereStringStep(line, i, reader, frame)
  if (frame === 'arith') {
    if (c === '(') reader.frames.push('arith')
    if (c === ')') reader.frames.pop()
    return [1, 'hidden']
  }
  const isDouble = frame === '"'
  const escape = frame === "$'" || (isDouble && reader.shell === 'bash') ? '\\' : isDouble ? '`' : ''
  if (c === escape) return [2, 'hidden']
  if (c === (isDouble ? '"' : "'")) {
    reader.frames.pop()
    return [1, 'hidden']
  }
  if (!isDouble || !line.startsWith('$(', i)) return [1, 'hidden']
  if (reader.shell === 'bash' && line[i + 2] === '(') {
    reader.frames.push('arith', 'arith')
    return [3, 'hidden']
  }
  reader.frames.push('sub')
  return [2, 'hidden']
}

// A step's text as it shows: the outermost quote's own marks stay, so a quoted path keeps its place.
function shown(text: string, how: Shown, framesBefore: number, framesAfter: number): string {
  if (how === 'blank') return ' '.repeat(text.length)
  if (framesBefore > 0 && framesAfter > 0) return hide(text)
  if (how === 'escape' && framesBefore === 0) return text.slice(0, 1) + hide(text.slice(1))
  return text
}

// One line read on from where the line before left the reader.
function maskLine(line: string, reader: Reader): string {
  let masked = ''
  for (let i = 0; i < line.length; ) {
    const before = reader.frames.length
    const isCode = before === 0 || innermost(reader) === 'sub'
    const [length, how] = isCode ? codeStep(line, i, reader) : quotedStep(line, i, reader)
    masked += shown(line.slice(i, i + length), how, before, reader.frames.length)
    i += length
  }
  return masked
}

export function maskCommand(command: string, isPowerShell = false): string {
  const reader: Reader = { frames: [], hereDocs: [], shell: isPowerShell ? 'powershell' : 'bash' }
  const lines = command.split('\n').map(line => {
    if (reader.hereDocs.length === 0) return maskLine(line, reader)
    if (line.trim() === reader.hereDocs[0]) reader.hereDocs.shift()
    return ' '.repeat(line.length)
  })
  return lines.join('\n')
}

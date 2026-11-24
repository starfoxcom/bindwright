// Swaps a computer's own paths in a chat file for placeholders and back.
// A chat file is JSON lines, so a Windows path shows up with its backslashes
// escaped once (inside a string) or twice (a string inside a string), and also
// with forward slashes; each form gets its own placeholder, so the way back
// writes the same form with the other computer's path.
'use strict'

const fs = require('fs')
const { StringDecoder } = require('string_decoder')

const CHUNK_BYTES = 1 << 20
const NAMES = { project: 'PROJECT', home: 'HOME' }
// Separator of each form as it appears in the file: "/", "\\" (escaped once), "\\\\" (twice).
const FORMS = { F: '/', E1: '\\\\', E2: '\\\\\\\\' }

// A drive path (C:\work) or a network one (\\server\share, \\wsl$\Ubuntu).
function isWindowsPath(text) {
  return /^([A-Za-z]:[\\/]|\\\\[^\\])/.test(text)
}

function segments(folder) {
  const trimmed = folder.replace(/[\\/]+$/, '')
  // One part per separator, so a network path keeps its two leading ones.
  return isWindowsPath(folder) ? trimmed.split(/[\\/]/) : trimmed.split('/')
}

function token(name, form) {
  return `__CHATSYNC_${NAMES[name]}_${form}__`
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A path starts after a line or string start, white space, a quote, a bracket,
// one of `=,;|<>`, an escaped newline or tab (`\n`, `\t`, `\r`), or a `:` that
// ends no drive letter, so https://x.com/home/sam, /mnt/backup/home/sam and,
// for a home of /Users/al, C:/Users/al are left alone. A path that starts with
// two slashes (a network path) never starts after `:`, as in https://nas/x.
const BEFORE = '^|[\\s"\'`([{<>=,;|]|\\\\[nrt]'
const COLON_NOT_DRIVE = '(?<!(?:^|[^\\p{L}\\p{M}\\p{N}_])[A-Za-z]):'

function startsAfter(text) {
  return text.startsWith('//') ? `(?<=${BEFORE})` : `(?<=${BEFORE}|${COLON_NOT_DRIVE})`
}

// A path ends where the folder's name ends, in any alphabet and with any accent
// or vowel sign written as its own mark, so C:/Users/al never matches inside
// C:/Users/alex, /home/jos inside /home/josé, or /home/sam.bak; a sentence's
// closing dot still ends it.
const ENDS_BEFORE = '(?![\\p{L}\\p{M}\\p{N}_-]|\\.[\\p{L}\\p{M}\\p{N}_-])'

// A folder with no name below the root or the drive ("/", "C:\") is everywhere
// in a chat, so it gets no rule.
function hasName(parts) {
  return parts.some(part => part && !/^[A-Za-z]:$/.test(part))
}

// The rules that turn `folder` into its placeholders, longest form first.
function outRules(name, folder) {
  const parts = segments(folder)
  if (!hasName(parts)) return []
  const isWindows = isWindowsPath(folder)
  const forms = isWindows ? Object.keys(FORMS) : ['F', 'E2']
  const flags = isWindows ? 'giu' : 'gu'
  return forms
    .map(form => ({ text: written(parts, form, isWindows), form }))
    .filter((rule, i, all) => all.findIndex(other => other.text === rule.text) === i)
    .sort((a, b) => b.text.length - a.text.length)
    .map(({ text, form }) => ({
      pattern: new RegExp(`${startsAfter(text)}${escapeRegExp(text)}${ENDS_BEFORE}`, flags),
      value: token(name, form),
    }))
}

// Placeholders without the form they were written in. Two copies of a chat are
// compared in this view, since a computer without drive letters writes every
// path in one form where a Windows computer wrote three.
function formless(text) {
  return text.replace(/__CHATSYNC_(PROJECT|HOME)_(?:F|E1|E2)__/g, '__CHATSYNC_$1__')
}

// Each placeholder and `folder` as this computer writes it in that form.
// A computer without drive letters writes every form with forward slashes.
function inValues(name, folder) {
  const parts = segments(folder)
  const isWindows = isWindowsPath(folder)
  return Object.keys(FORMS).map(form => [token(name, form), written(parts, form, isWindows)])
}

// How many times each form sits inside a JSON string: once for F and E1, twice
// for E2, a JSON string held inside another.
const DEPTH = { F: 1, E1: 1, E2: 2 }

// `folder`'s segments as a chat file holds them in `form`: each escaped for its
// JSON depth, so a `"` or `\` in a folder name keeps the line valid JSON.
function written(parts, form, isWindows) {
  const escape = text => JSON.stringify(text).slice(1, -1)
  const escaped = parts.map(part => Array.from({ length: DEPTH[form] }).reduce(escape, part))
  return escaped.join(isWindows ? FORMS[form] : '/')
}

function applyRules(text, rules) {
  return rules.reduce((out, rule) => out.replace(rule.pattern, () => rule.value), text)
}

// Text in a chat that already reads like a placeholder (a chat about this mod)
// is escaped on the way out and restored on the way in, so it never becomes a
// path on the other computer. Every `CHATSYNC_` gets `LIT_` after it, which no
// placeholder holds; the way back reads placeholders and escapes in one pass,
// so a path it writes in is never read as an escape.
const LITERAL = /CHATSYNC_/g
const WRITTEN = /__CHATSYNC_(?:PROJECT|HOME)_(?:F|E1|E2)__|CHATSYNC_LIT_/g

// The deeper of the two folders goes first, as the longest prefix wins: the
// project usually sits inside the home folder, but a session started in /home
// or C:\Users holds the home folder inside the project.
// The rules match the folders as the escape leaves them, so a folder whose
// own name holds the placeholders' prefix is still swapped.
function neutralize(root, home) {
  const escape = text => text.replace(LITERAL, 'CHATSYNC_LIT_')
  const project = outRules('project', escape(root))
  const homeRules = outRules('home', escape(home))
  const isHomeDeeper = segments(home).length > segments(root).length
  const rules = isHomeDeeper ? [...homeRules, ...project] : [...project, ...homeRules]
  return text => applyRules(escape(text), rules)
}

function expand(root, home) {
  const values = Object.fromEntries([...inValues('project', root), ...inValues('home', home)])
  return text => text.replace(WRITTEN, match => values[match] ?? 'CHATSYNC_')
}

// Writes `src` through `change`, line by line, to `dst`. With `completeOnly`, a
// last line still being written (no newline yet) is left out, so the copy never
// ends halfway through a record.
function transformFile(src, dst, change, completeOnly) {
  const input = fs.openSync(src, 'r')
  const output = fs.openSync(dst, 'w')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.alloc(CHUNK_BYTES)
  let carry = ''
  try {
    let read
    while ((read = fs.readSync(input, buffer, 0, CHUNK_BYTES, null)) > 0) {
      const text = carry + decoder.write(buffer.subarray(0, read))
      const end = text.lastIndexOf('\n') + 1
      if (end > 0) fs.writeSync(output, change(text.slice(0, end)))
      carry = text.slice(end)
    }
    carry += decoder.end()
    if (carry && !completeOnly) fs.writeSync(output, change(carry))
  } finally {
    fs.closeSync(input)
    fs.closeSync(output)
  }
}

// Appends the lines of `src` after its first `skipLines` to `dst`, through
// `change`. A last line with no newline yet is left out.
function appendLines(src, skipLines, dst, change) {
  const input = fs.openSync(src, 'r')
  const output = fs.openSync(dst, 'a')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.alloc(CHUNK_BYTES)
  let toSkip = skipLines
  let carry = ''
  try {
    let read
    while ((read = fs.readSync(input, buffer, 0, CHUNK_BYTES, null)) > 0) {
      let text = carry + decoder.write(buffer.subarray(0, read))
      while (toSkip > 0 && text.includes('\n')) {
        text = text.slice(text.indexOf('\n') + 1)
        toSkip--
      }
      const end = toSkip > 0 ? 0 : text.lastIndexOf('\n') + 1
      if (end > 0) fs.writeSync(output, change(text.slice(0, end)))
      carry = text.slice(end)
    }
  } finally {
    fs.closeSync(input)
    fs.closeSync(output)
  }
}

function countLines(file) {
  const input = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(CHUNK_BYTES)
  let lines = 0
  try {
    let read
    while ((read = fs.readSync(input, buffer, 0, CHUNK_BYTES, null)) > 0) {
      for (let at = 0; at < read; at++) if (buffer[at] === 10) lines++
    }
    return lines
  } finally {
    fs.closeSync(input)
  }
}

// Opening never follows a link where the system can refuse one, and never
// waits on a pipe planted at the name.
const READ_PLAIN = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)

// Copies the plain file `src` to `dst` through one open handle, checked to be
// the file the name held when it was looked at (same disk, same file number),
// so a file swapped for a link meanwhile is never read. False when `src` is no
// plain file or was swapped.
function copyPlainFile(src, dst) {
  let named
  try {
    named = fs.lstatSync(src, { bigint: true })
    if (!named.isFile()) return false
  } catch {
    return false
  }
  let input
  try {
    input = fs.openSync(src, READ_PLAIN)
  } catch {
    return false
  }
  try {
    const opened = fs.fstatSync(input, { bigint: true })
    if (!opened.isFile() || opened.ino !== named.ino || opened.dev !== named.dev) return false
    copyOpened(input, dst)
    return true
  } finally {
    fs.closeSync(input)
  }
}

function copyOpened(input, dst) {
  const output = fs.openSync(dst, 'w')
  const buffer = Buffer.alloc(CHUNK_BYTES)
  try {
    let read
    while ((read = fs.readSync(input, buffer, 0, CHUNK_BYTES, null)) > 0) fs.writeSync(output, buffer, 0, read)
  } finally {
    fs.closeSync(output)
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return -1
  }
}

// True when the file `shorter` holds exactly the first bytes of `longer`. A chat
// file only ever grows, so the longer of two copies that agree on the shorter
// one's bytes is the newer one.
function startsWithFile(longer, shorter) {
  const shortSize = sizeOf(shorter)
  if (shortSize < 0 || sizeOf(longer) < shortSize) return false
  const a = fs.openSync(longer, 'r')
  const b = fs.openSync(shorter, 'r')
  const bufA = Buffer.alloc(CHUNK_BYTES)
  const bufB = Buffer.alloc(CHUNK_BYTES)
  try {
    for (let at = 0; at < shortSize; at += CHUNK_BYTES) {
      const want = Math.min(CHUNK_BYTES, shortSize - at)
      fs.readSync(a, bufA, 0, want, at)
      fs.readSync(b, bufB, 0, want, at)
      if (!bufA.subarray(0, want).equals(bufB.subarray(0, want))) return false
    }
    return true
  } finally {
    fs.closeSync(a)
    fs.closeSync(b)
  }
}

module.exports = {
  neutralize, expand, formless, transformFile, appendLines, countLines, startsWithFile, sizeOf, copyPlainFile,
}

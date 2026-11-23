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
// one of `=:,;|<>`, or an escaped newline or tab (`\n`, `\t`, `\r`), so
// https://x.com/home/sam and /mnt/backup/home/sam are left alone.
const STARTS_AFTER = '(?<=^|[\\s"\'`([{<>=:,;|]|\\\\[nrt])'
// A path ends where the folder's name ends, so C:/Users/al never matches inside
// C:/Users/alex or /home/sam.bak; a sentence's closing dot still ends it.
const ENDS_BEFORE = '(?![\\w-]|\\.[\\w-])'

// A folder with no name below the root or the drive ("/", "C:\") is everywhere
// in a chat, so it gets no rule.
function hasName(parts) {
  return parts.some(part => part && !/^[A-Za-z]:$/.test(part))
}

// The rules that turn `folder` into its placeholders, longest form first.
function outRules(name, folder) {
  const parts = segments(folder)
  if (!hasName(parts)) return []
  const forms = isWindowsPath(folder) ? Object.keys(FORMS) : ['F']
  const flags = isWindowsPath(folder) ? 'gi' : 'g'
  return forms
    .map(form => ({ text: parts.join(FORMS[form]), form }))
    .sort((a, b) => b.text.length - a.text.length)
    .map(({ text, form }) => ({
      pattern: new RegExp(`${STARTS_AFTER}${escapeRegExp(text)}${ENDS_BEFORE}`, flags),
      value: token(name, form),
    }))
}

// Placeholders without the form they were written in. Two copies of a chat are
// compared in this view, since a computer without drive letters writes every
// path in one form where a Windows computer wrote three.
function formless(text) {
  return text.replace(/__CHATSYNC_(PROJECT|HOME)_(?:F|E1|E2)__/g, '__CHATSYNC_$1__')
}

// The rules that turn each placeholder into `folder` as this computer writes it.
// A computer without drive letters writes every form with forward slashes.
function inRules(name, folder) {
  const parts = segments(folder)
  const isWindows = isWindowsPath(folder)
  return Object.keys(FORMS).map(form => ({
    pattern: new RegExp(escapeRegExp(token(name, form)), 'g'),
    value: parts.join(isWindows ? FORMS[form] : '/'),
  }))
}

function applyRules(text, rules) {
  return rules.reduce((out, rule) => out.replace(rule.pattern, () => rule.value), text)
}

// Text in a chat that already reads like a placeholder (a chat about this mod)
// is escaped on the way out and restored on the way in, so it never becomes a
// path on the other computer.
const LITERAL = /__CHATSYNC_/g
const ESCAPED = /__CHATSYNC_LIT_/g

// The project folder goes first, since it usually sits inside the home folder.
function neutralize(root, home) {
  const rules = [...outRules('project', root), ...outRules('home', home)]
  return text => applyRules(text.replace(LITERAL, '__CHATSYNC_LIT_'), rules)
}

function expand(root, home) {
  const rules = [...inRules('project', root), ...inRules('home', home)]
  return text => applyRules(text, rules).replace(ESCAPED, '__CHATSYNC_')
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
  neutralize, expand, formless, transformFile, appendLines, countLines, startsWithFile, sizeOf,
}

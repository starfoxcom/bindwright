// One chat-sync run at a time on this computer. Runs share the sync place, the
// clone and the state files, so a run never meets another one's half-done work:
// a copy placed but not yet recorded, or a clone being reset under it.
'use strict'

const fs = require('fs')
const path = require('path')
const base = require('./sync.cjs')

const WAIT_MS = 30_000
const POLL_MS = 100
// Longer than any run lasts: a move is stopped after 300 s.
const HELD_MAX_MS = 10 * 60_000
// A run that took the lock writes its process id at once; a lock still empty
// after this long was left by a run stopped in between.
const UNWRITTEN_MS = 5_000
const BUSY = 'Another chat-sync run on this computer took longer than 30 s, so this one did nothing; '
  + 'the next copy catches up.'

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function readLock(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), age: Date.now() - fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

function isStale({ text, age }) {
  const owner = Number.parseInt(text, 10)
  if (!owner) return age > UNWRITTEN_MS
  return !isAlive(owner) || age > HELD_MAX_MS
}

function tryTake(file) {
  try {
    const handle = fs.openSync(file, 'wx')
    fs.writeSync(handle, String(process.pid))
    fs.closeSync(handle)
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const held = readLock(file)
  // Removed only while it still holds what was judged stale, so a lock another
  // run took meanwhile stays.
  if (held && isStale(held) && readLock(file)?.text === held.text) fs.rmSync(file, { force: true })
  return false
}

// Runs `work` while holding the lock. Before any place is chosen, the helper's
// folder does not exist yet and there is nothing to share.
function withRunLock(work) {
  if (!fs.existsSync(base.dataDir())) return work()
  const file = path.join(base.dataDir(), 'run.lock')
  const giveUpAt = Date.now() + WAIT_MS
  while (!tryTake(file)) {
    if (Date.now() > giveUpAt) return { error: BUSY }
    sleep(POLL_MS)
  }
  try {
    return work()
  } finally {
    fs.rmSync(file, { force: true })
  }
}

module.exports = { withRunLock }

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
const BUSY = 'Another chat-sync run on this computer was still going when this one had to stop, '
  + 'so this one did nothing; the next copy catches up.'

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
  return !owner || !isAlive(owner) || age > HELD_MAX_MS
}

// The process id is written to a file of this run's own, then linked to the
// lock's name, which only one run can do: the lock is never seen empty.
function tryTake(file) {
  const own = `${file}.${process.pid}.new`
  fs.writeFileSync(own, String(process.pid))
  try {
    fs.linkSync(own, file)
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  } finally {
    fs.rmSync(own, { force: true })
  }
  const held = readLock(file)
  if (held && isStale(held)) takeOver(file, held)
  return false
}

// Moves a stale lock aside under a name of this run's own, which only one run
// can do to a given file, then checks what it moved: a lock that another run
// took after it was judged stale goes back. Between the move and the putting
// back, a third run can take the name too; making that impossible needs an
// operating-system lock, which Node does not offer on every system. Two runs
// working at once then cost a repeated copy or a git error, never a chat: each
// keeps its private copies in a folder of its own (`inWorkFolder`).
function takeOver(file, held) {
  const aside = `${file}.${process.pid}.stale`
  try {
    fs.renameSync(file, aside)
  } catch {
    return
  }
  const moved = readLock(aside)
  if (moved && moved.text !== held.text) {
    try {
      fs.linkSync(aside, file)
    } catch {
      // A third run took the name meanwhile, so the lock it made holds.
    }
  }
  fs.rmSync(aside, { force: true })
}

// Lets the lock go only while it is still this run's own.
function release(file) {
  if (readLock(file)?.text === String(process.pid)) fs.rmSync(file, { force: true })
}

// Runs `work` while holding the lock, waiting for it up to 30 s or the run's
// deadline, whichever comes first. Before any place is chosen, the helper's
// folder does not exist yet and there is nothing to share.
function withRunLock(work) {
  if (!fs.existsSync(base.dataDir())) return work()
  const file = path.join(base.dataDir(), 'run.lock')
  const giveUpAt = Date.now() + base.callTimeout(WAIT_MS)
  while (!tryTake(file)) {
    if (Date.now() > giveUpAt) return { error: BUSY }
    sleep(POLL_MS)
  }
  try {
    return work()
  } finally {
    release(file)
  }
}

module.exports = { withRunLock, isAlive }

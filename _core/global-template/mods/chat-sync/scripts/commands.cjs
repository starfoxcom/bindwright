// The chat-sync helper's commands. Every one returns a plain object that
// sync.cjs prints as JSON.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const base = require('./sync.cjs')
const { neutralize, expand, transformFile, startsWithFile, sizeOf } = require('./paths.cjs')
const { syncPlaces } = require('./places.cjs')

const CHAT = /^[\w-]+\.jsonl$/

function chatFiles(folder) {
  try {
    return fs.readdirSync(folder).filter(name => CHAT.test(name))
  } catch {
    return []
  }
}

// How copy `mine` stands against copy `theirs`, both in the same form.
function compare(mine, theirs) {
  if (sizeOf(theirs) < 0) return 'new'
  if (startsWithFile(mine, theirs)) return sizeOf(mine) === sizeOf(theirs) ? 'same' : 'ahead'
  if (startsWithFile(theirs, mine)) return 'behind'
  return 'diverged'
}

function removeQuietly(file) {
  fs.rmSync(file, { force: true })
}

function commitAndPush(store, label) {
  base.git(store, 'add', '-A')
  if (base.git(store, 'diff', '--cached', '--quiet').ok) return { pushed: false }
  const commit = base.git(store, 'commit', '-m', `chat-sync: ${label}`)
  if (!commit.ok) return { pushError: commit.out }
  const pulled = pull(store)
  if (pulled.error) return { pushError: pulled.error }
  const push = base.git(store, 'push')
  return push.ok ? { pushed: true } : { pushError: push.out }
}

function pull(store) {
  if (!base.git(store, 'rev-parse', '--verify', 'HEAD').ok) return {}
  if (!base.git(store, 'ls-remote', '--exit-code', '--heads', 'origin').ok) return {}
  const run = base.git(store, 'pull', '--rebase', '--autostash')
  if (run.ok) return {}
  base.git(store, 'rebase', '--abort')
  return { error: run.out }
}

// Where the chats go now, or a reason nothing can be copied.
function openStore() {
  const place = base.readPlace()
  const store = base.storeRoot(place)
  if (!store) return { skipped: 'off' }
  if (place.kind === 'git' && !fs.existsSync(path.join(store, '.git'))) {
    return { error: 'The chat repo is not cloned here. Run /chat-sync move git <owner/repo> again.' }
  }
  return { place, store }
}

// Copies one chat out to the sync place, unless another computer has it open
// or holds a newer copy. With `release`, this computer's lock on it ends too.
function out([transcript, root, release]) {
  const opened = openStore()
  if (!opened.store) return opened
  const { place, store } = opened
  const id = path.basename(transcript, '.jsonl')
  const me = base.machineId()
  const dir = path.join(store, base.projectKey(root))
  const lockFile = path.join(dir, `${id}.lock`)
  const lock = base.lockOf(lockFile)
  if (base.isHeldElsewhere(lock, me)) return { held: id, by: lock.machine }
  fs.mkdirSync(dir, { recursive: true })
  const mine = path.join(dir, `.${id}.${me}.tmp`)
  transformFile(transcript, mine, neutralize(root, os.homedir()), true)
  const result = placeCopy(mine, path.join(dir, `${id}.jsonl`), id, me)
  if (release === 'release') removeQuietly(lockFile)
  else base.writeJson(lockFile, { machine: me, at: Date.now() })
  if (place.kind === 'git' && result.copied) Object.assign(result, commitAndPush(store, `${id} from ${me}`))
  return result
}

function placeCopy(mine, target, id, me) {
  const verdict = compare(mine, target)
  if (verdict === 'new' || verdict === 'ahead') {
    fs.renameSync(mine, target)
    return { copied: id }
  }
  if (verdict === 'diverged') {
    const conflicts = path.join(path.dirname(target), 'conflicts')
    fs.mkdirSync(conflicts, { recursive: true })
    fs.renameSync(mine, path.join(conflicts, `${id}.${me}.jsonl`))
    return { conflict: id }
  }
  removeQuietly(mine)
  return verdict === 'behind' ? { behind: id } : { same: id }
}

// The store copies already looked at, by size and time, so an unchanged one
// is not read again at the next start.
function seenFile() {
  return path.join(base.dataDir(), 'seen.json')
}

function stampOf(file) {
  const stat = fs.statSync(file)
  return `${stat.size}:${Math.round(stat.mtimeMs)}`
}

// Brings each newer chat of this project from the sync place into this
// computer's chat folder. The chat open in this session is never written.
function bringIn([chatDir, root, openId]) {
  const opened = openStore()
  if (!opened.store) return opened
  const { place, store } = opened
  const pulled = place.kind === 'git' ? pull(store) : {}
  const key = base.projectKey(root)
  const dir = path.join(store, key)
  const seen = base.readJson(seenFile(), {})
  const result = { imported: [], conflicts: [], behind: [], openElsewhere: [], ...pulled }
  const me = base.machineId()
  for (const name of chatFiles(dir)) {
    const id = name.slice(0, -'.jsonl'.length)
    const lock = base.lockOf(path.join(dir, `${id}.lock`))
    if (base.isHeldElsewhere(lock, me)) result.openElsewhere.push({ id, by: lock.machine })
    const theirs = path.join(dir, name)
    const stamp = stampOf(theirs)
    if (seen[`${key}/${id}`] === stamp && fs.existsSync(path.join(chatDir, name))) continue
    const verdict = bringOne(theirs, path.join(chatDir, name), root, id === openId)
    if (verdict === 'imported') result.imported.push(id)
    if (verdict === 'conflict') result.conflicts.push(id)
    if (verdict === 'open') result.behind.push(id)
    if (verdict !== 'open') seen[`${key}/${id}`] = stamp
  }
  base.writeJson(seenFile(), seen)
  return result
}

function bringOne(theirs, local, root, isOpen) {
  const home = os.homedir()
  const hasLocal = sizeOf(local) >= 0
  const mine = `${local}.chat-sync.mine`
  if (hasLocal) transformFile(local, mine, neutralize(root, home), false)
  const verdict = hasLocal ? compare(mine, theirs) : 'new'
  if (hasLocal) removeQuietly(mine)
  if (verdict === 'same' || verdict === 'ahead') return 'kept'
  if (verdict === 'diverged') return 'conflict'
  if (isOpen) return 'open'
  const incoming = `${local}.chat-sync.in`
  transformFile(theirs, incoming, expand(root, home), false)
  fs.renameSync(incoming, local)
  return 'imported'
}

function run([command, ...args]) {
  const { move } = require('./move.cjs')
  if (command === 'out') return out(args)
  if (command === 'in') return bringIn(args)
  if (command === 'move') return move(args)
  if (command === 'places') return { places: syncPlaces() }
  if (command === 'status') return status(args)
  return { error: `Unknown command: ${command || '(none)'}` }
}

function status([root]) {
  const place = base.readPlace()
  const store = base.storeRoot(place)
  const key = root ? base.projectKey(root) : null
  const chats = store && key ? chatFiles(path.join(store, key)).length : 0
  return { place, machine: base.machineId(), project: key, chats, git: hasGit() }
}

function hasGit() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
}

module.exports = { run, out, bringIn, compare, commitAndPush, pull, chatFiles }

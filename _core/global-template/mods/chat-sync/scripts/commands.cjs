// The chat-sync helper's commands. Every one returns a plain object that
// sync.cjs prints as JSON.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const base = require('./sync.cjs')
const paths = require('./paths.cjs')
const { syncPlaces } = require('./places.cjs')

const { neutralize, expand, formless, transformFile, appendLines, countLines, startsWithFile, sizeOf } = paths
const CHAT = /^[\w-]+\.jsonl$/

function chatFiles(folder) {
  try {
    return fs.readdirSync(folder).filter(name => CHAT.test(name))
  } catch {
    return []
  }
}

// How file `mine` stands against file `theirs`.
function compare(mine, theirs) {
  if (sizeOf(theirs) < 0) return 'new'
  if (startsWithFile(mine, theirs)) return sizeOf(mine) === sizeOf(theirs) ? 'same' : 'ahead'
  if (startsWithFile(theirs, mine)) return 'behind'
  return 'diverged'
}

// How this computer's chat `local` stands against the stored copy `stored`,
// with the line count of each. Both are read in one view: each computer's paths
// as placeholders, without the form they were written in. The stored copy goes
// through this computer's paths first, so a path that is this computer's in it
// reads the same as in the local chat.
function compareChat(local, stored, root) {
  if (sizeOf(stored) < 0) return { verdict: 'new' }
  const home = os.homedir()
  const toPlaceholders = neutralize(root, home)
  const toLocal = expand(root, home)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sync-'))
  try {
    const mine = path.join(dir, 'mine')
    const theirs = path.join(dir, 'theirs')
    transformFile(local, mine, text => formless(toPlaceholders(text)), true)
    transformFile(stored, theirs, text => formless(toPlaceholders(toLocal(text))), true)
    return { verdict: compare(mine, theirs), localLines: countLines(mine), storedLines: countLines(theirs) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
  const branch = pulled.branch || base.git(store, 'symbolic-ref', '--short', 'HEAD').out
  const push = base.git(store, 'push', 'origin', `HEAD:refs/heads/${branch}`)
  return push.ok ? { pushed: true } : { pushError: push.out }
}

// A clone with no commit yet has nothing to reset to, and git refuses to pull
// into it while its index holds anything, so its index goes instead.
function dropUncommitted(store) {
  if (base.git(store, 'rev-parse', '--verify', '-q', 'HEAD').ok) base.git(store, 'reset', '--hard', '-q')
  else removeQuietly(path.join(store, '.git', 'index'))
  base.git(store, 'clean', '-fdq')
}

// The repo's default branch, or null while nothing has been pushed to it.
function remoteBranch(store) {
  const head = base.git(store, 'ls-remote', '--symref', 'origin', 'HEAD')
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.out)
  return head.ok && match ? match[1] : null
}

// Brings the clone up to the repo, naming the branch, so a clone made while the
// repo was empty catches up too. Every file in the clone can be rebuilt from
// this computer's chat folder, so changes never committed (a copy cut short, a
// push refused) are dropped first, and a commit of this computer's that cannot
// be replayed on top (another computer changed the same chat meanwhile) is
// dropped too: the next copy out compares the chat against the repo's copy.
function pull(store) {
  dropUncommitted(store)
  const branch = remoteBranch(store)
  if (!branch) return {}
  const run = base.git(store, 'pull', '--rebase', 'origin', branch)
  if (run.ok) return { branch }
  base.git(store, 'rebase', '--abort')
  const reset = base.git(store, 'reset', '--hard', `origin/${branch}`)
  if (!reset.ok) return { error: run.out }
  return { error: CHANGED_MEANWHILE }
}

const CHANGED_MEANWHILE = 'Another computer changed the chat repo at the same time; '
  + 'this computer copies its chats again at the next turn.'

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
  const isGit = place.kind === 'git'
  const pulled = isGit ? pull(store) : {}
  if (pulled.error) return { error: pulled.error }
  const id = path.basename(transcript, '.jsonl')
  const me = base.machineId()
  const dir = path.join(store, base.projectKey(root))
  const lockFile = path.join(dir, `${id}.lock`)
  const lock = base.lockOf(lockFile)
  if (base.isHeldElsewhere(lock, me)) return { held: id, by: lock.machine }
  const refused = isGit ? privateRepoError(place.repo) : null
  if (refused) return { pushError: refused }
  fs.mkdirSync(dir, { recursive: true })
  const result = placeCopy(transcript, path.join(dir, `${id}.jsonl`), root, { id, me })
  if (release === 'release') removeQuietly(lockFile)
  else base.writeJson(lockFile, { machine: me, at: Date.now() })
  return isGit ? Object.assign(result, commitAndPush(store, `${id} from ${me}`)) : result
}

const VISIBILITY_FRESH_MS = 60 * 60_000

// The repo is checked again before a push, at most once an hour, in case it was
// made public since it was chosen.
function privateRepoError(repo) {
  const file = path.join(base.dataDir(), 'visibility.json')
  const last = base.readJson(file, {})
  if (last.repo === repo && Date.now() - last.at < VISIBILITY_FRESH_MS) return null
  const { checkPrivate } = require('./move.cjs')
  const refused = checkPrivate(repo)
  if (!refused) base.writeJson(file, { repo, at: Date.now() })
  return refused
}

// Writes this computer's chat into the store as the verdict says. A copy that
// is ahead keeps the stored lines as they are and gains only the new ones, so
// each line stays in the form the computer that wrote it used.
function placeCopy(transcript, target, root, { id, me }) {
  const { verdict, storedLines } = compareChat(transcript, target, root)
  const toPlaceholders = neutralize(root, os.homedir())
  if (verdict === 'diverged') {
    const conflicts = path.join(path.dirname(target), 'conflicts')
    fs.mkdirSync(conflicts, { recursive: true })
    transformFile(transcript, path.join(conflicts, `${id}.${me}.jsonl`), toPlaceholders, true)
    return { conflict: id }
  }
  if (verdict !== 'new' && verdict !== 'ahead') return verdict === 'behind' ? { behind: id } : { same: id }
  const next = path.join(path.dirname(target), `.${id}.${me}.tmp`)
  if (verdict === 'new') transformFile(transcript, next, toPlaceholders, true)
  else {
    fs.copyFileSync(target, next)
    appendLines(transcript, storedLines, next, toPlaceholders)
  }
  fs.renameSync(next, target)
  return { copied: id }
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
  const result = { imported: [], conflicts: [], behind: [], openElsewhere: [] }
  if (pulled.error) result.error = pulled.error
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

// Brings one stored chat in. A local chat that is behind keeps its own complete
// lines and gains only the stored ones it lacks; a last line cut off mid-write
// is dropped, since the stored copy's next line takes its place.
function bringOne(theirs, local, root, isOpen) {
  const hasLocal = sizeOf(local) >= 0
  const { verdict, localLines } = hasLocal ? compareChat(local, theirs, root) : { verdict: 'behind', localLines: 0 }
  if (verdict === 'same' || verdict === 'ahead') return 'kept'
  if (verdict === 'diverged') return 'conflict'
  if (isOpen) return 'open'
  const incoming = `${local}.chat-sync.in`
  if (hasLocal) transformFile(local, incoming, text => text, true)
  else removeQuietly(incoming)
  appendLines(theirs, localLines, incoming, expand(root, os.homedir()))
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

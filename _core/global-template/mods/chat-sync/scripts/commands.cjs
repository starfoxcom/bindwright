// The chat-sync helper's commands. Every one returns a plain object that
// sync.cjs prints as JSON.
//
// The sync place holds each chat as one file per computer:
// <project>/<chat id>/<computer id>.jsonl. A computer writes only its own file
// and reads the others', so no two computers ever write the same file: a git
// pull never meets a conflict and a sync app never makes a "conflicted copy".
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const base = require('./sync.cjs')
const paths = require('./paths.cjs')
const { syncPlaces } = require('./places.cjs')

const {
  neutralize, expand, formless, transformFile, appendLines, countLines, startsWithFile, sizeOf, copyPlainFile,
} = paths
const CHAT = /^[\w-]+\.jsonl$/
const ID = /^[\w-]+$/
const VISIBILITY_FRESH_MS = 60 * 60_000
const CHANGED_MEANWHILE = 'Another computer changed the chat repo at the same time; '
  + 'this computer copies its chats again at the next turn.'

// What another computer put in the sync place is read as input: a link there is
// never followed, read or written through.
function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

function isPlainFile(file) {
  try {
    return fs.lstatSync(file).isFile()
  } catch {
    return false
  }
}

function ensureFolder(folder) {
  fs.mkdirSync(folder, { recursive: true })
  if (!fs.lstatSync(folder).isDirectory()) {
    throw new Error(`${folder} is a link, and chat sync writes only into folders.`)
  }
}

function chatFiles(folder) {
  try {
    return fs.readdirSync(folder).filter(name => CHAT.test(name) && isPlainFile(path.join(folder, name)))
  } catch {
    return []
  }
}

// The chats a project folder of the sync place holds, by id. A project folder
// that is a link is not read.
function chatIds(projectDir) {
  if (!isRealFolder(projectDir)) return []
  try {
    return fs.readdirSync(projectDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && ID.test(entry.name))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

// This computer's id as a file name in the sync place, in the same letters the
// readers accept, for an id saved before ids were limited to them too.
function ownName() {
  return `${base.machineId().replace(/[^\w-]+/g, '-')}.jsonl`
}

// A temporary copy of this computer's, named the way sync apps name theirs.
function tempOf(own) {
  return path.join(path.dirname(own), `.${path.basename(own)}.${process.pid}.tmp`)
}

// Removes temporary copies this computer left in a chat's folder, from a helper
// stopped before it renamed them. One younger than a helper's longest run may
// belong to another session's helper still writing it, so it stays.
const TEMP_STALE_MS = 5 * 60_000

function sweepTemps(own) {
  const prefix = `.${path.basename(own)}.`
  for (const name of fs.readdirSync(path.dirname(own))) {
    const file = path.join(path.dirname(own), name)
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    if (!isPlainFile(file) || Date.now() - fs.lstatSync(file).mtimeMs > TEMP_STALE_MS) removeQuietly(file)
  }
}

function isRealFolder(folder) {
  try {
    return fs.lstatSync(folder).isDirectory()
  } catch {
    return false
  }
}

// How file `mine` stands against file `theirs`.
function compare(mine, theirs) {
  if (sizeOf(theirs) < 0) return 'new'
  if (startsWithFile(mine, theirs)) return sizeOf(mine) === sizeOf(theirs) ? 'same' : 'ahead'
  if (startsWithFile(theirs, mine)) return 'behind'
  return 'diverged'
}

// How this computer's chat `local` stands against another computer's copy
// `stored`, with the local line count. Both are read as placeholders without
// the form a path was written in; the stored copy is made this computer's
// first, so a path that is this computer's in it reads the same as here.
function compareChat(local, stored, root) {
  const home = os.homedir()
  const toPlaceholders = neutralize(root, home)
  const toLocal = expand(root, home)
  return inWorkFolder(dir => {
    const mine = path.join(dir, 'mine')
    const theirs = path.join(dir, 'theirs')
    transformFile(local, mine, text => formless(toPlaceholders(text)), true)
    transformFile(stored, theirs, text => formless(toPlaceholders(toLocal(text))), true)
    return { verdict: compare(mine, theirs), localLines: countLines(mine), storedLines: countLines(theirs) }
  })
}

// Runs `work` with a private folder of this computer's, removed after.
function inWorkFolder(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sync-'))
  try {
    return work(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Removes a file, or whatever else sits at its name.
function removeQuietly(file) {
  fs.rmSync(file, { force: true, recursive: true })
}

// Commits what this computer wrote, brings the clone up to the repo and pushes.
function publish(store, label) {
  base.git(store, 'add', '-A')
  if (!base.git(store, 'diff', '--cached', '--quiet').ok) {
    const commit = base.git(store, 'commit', '-q', '-m', `chat-sync: ${label}`)
    if (!commit.ok) return { pushError: commit.out }
  }
  const pulled = pull(store)
  if (pulled.error) return { pushError: pulled.error }
  const branch = pulled.branch || base.git(store, 'symbolic-ref', '--short', 'HEAD').out
  if (!base.git(store, 'rev-parse', '--verify', '-q', 'HEAD').ok) return { pushed: false }
  const push = base.git(store, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
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
// repo was empty catches up too. Files never committed (a copy cut short) are
// dropped first: each is this computer's own and is written again from its chat
// folder. Every commit touches only its own computer's files, so a pull that
// still fails is reset to the repo's copy, and this computer's next copy out
// writes its files again.
function pull(store) {
  dropUncommitted(store)
  const branch = remoteBranch(store)
  if (!branch) return {}
  const run = base.git(store, 'pull', '-q', '--rebase', 'origin', branch)
  if (run.ok) return { branch }
  base.git(store, 'rebase', '--abort')
  const reset = base.git(store, 'reset', '--hard', '-q', `origin/${branch}`)
  return { error: reset.ok ? CHANGED_MEANWHILE : run.out }
}

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


// The clone's own ignore list (never committed) leaves temporary copies out.
function keepTempsOutOfGit(store) {
  const exclude = path.join(store, '.git', 'info', 'exclude')
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
  if (text.split('\n').includes('.*.tmp')) return
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.*.tmp\n`)
}

// Where the chats go now, or a reason nothing can be copied. Every git call
// in the clone runs with the mod's own settings (`gitSettings` in sync.cjs).
function openStore() {
  const place = base.readPlace()
  const store = base.storeRoot(place)
  if (!store) return { skipped: 'off' }
  if (place.kind === 'git') {
    if (!fs.existsSync(path.join(store, '.git'))) {
      return { error: 'The chat repo is not cloned here. Run /chat-sync move git <owner/repo> again.' }
    }
    keepTempsOutOfGit(store)
  }
  return { place, store }
}

// This computer's own copy of one chat in the sync place.
function ownCopy(projectDir, id) {
  return path.join(projectDir, id, ownName())
}

// Other computers' copies of one chat, the longest first.
function otherCopies(folder) {
  const own = ownName()
  return chatFiles(folder).filter(name => name !== own).map(name => path.join(folder, name))
    .sort((a, b) => sizeOf(b) - sizeOf(a))
}

// Other computers' copies of one chat, each read once into the private folder
// `work`, longest first, as { copy, read }; one that is no plain file is left out.
function* readCopies(folder, work) {
  for (const [at, copy] of otherCopies(folder).entries()) {
    const read = path.join(work, `copy-${at}`)
    if (copyPlainFile(copy, read)) yield { copy, read }
  }
}

// The longest other computer's copy that the chat `transcript` starts with.
function extendedCopy(transcript, folder, root, work) {
  for (const { read } of readCopies(folder, work)) {
    const { verdict, storedLines } = compareChat(transcript, read, root)
    if (verdict === 'ahead' || verdict === 'same') return { read, storedLines }
  }
  return null
}

// Writes this computer's own copy of one chat: the lines of the longest other
// copy the chat extends, byte for byte, then this computer's lines after them,
// so a path the other computer left as text stays text. It is built in a
// private folder and only then copied into the sync place. True when it changed.
function sendChat(transcript, root, projectDir) {
  const id = path.basename(transcript, '.jsonl')
  ensureFolder(projectDir)
  ensureFolder(path.join(projectDir, id))
  const own = ownCopy(projectDir, id)
  sweepTemps(own)
  return inWorkFolder(work => {
    const built = path.join(work, 'own')
    const toPlaceholders = neutralize(root, os.homedir())
    const start = extendedCopy(transcript, path.dirname(own), root, work)
    if (start) {
      transformFile(start.read, built, text => text, true)
      appendLines(transcript, start.storedLines, built, toPlaceholders)
    } else {
      transformFile(transcript, built, toPlaceholders, true)
    }
    if (compare(built, own) === 'same') return false
    const next = tempOf(own)
    removeQuietly(next)
    fs.copyFileSync(built, next, fs.constants.COPYFILE_EXCL)
    fs.renameSync(next, own)
    return true
  })
}

// A chat counts as sent while neither it nor its own copy in the sync place has
// changed since; a copy a pull or a reset took back reads as not sent. The
// chat's stamp is taken before it is read, so lines added during the copy
// leave it reading as not sent.
function sentStamp(localStamp, own) {
  return `${localStamp}|${isPlainFile(own) ? stampOf(own) : 'none'}`
}

// The chats sent, by size and time, and the other computers' copies already
// looked at, so an unchanged file is not read again.
function seenFile() {
  return path.join(base.dataDir(), 'seen.json')
}

function stampOf(file) {
  const stat = fs.statSync(file)
  return `${stat.size}:${Math.round(stat.mtimeMs)}`
}

// Copies one chat out to the sync place.
function out([transcript, root]) {
  const opened = openStore()
  if (!opened.store) return opened
  const { place, store } = opened
  const isGit = place.kind === 'git'
  const refused = isGit ? privateRepoError(place.repo) : null
  if (refused) return { pushError: refused }
  // Claude Code writes the chat file once the first message is sent.
  if (!isPlainFile(transcript)) return { skipped: 'no chat yet' }
  const id = path.basename(transcript, '.jsonl')
  const key = base.projectKey(root)
  const projectDir = path.join(store, key)
  const stamp = stampOf(transcript)
  const isChanged = sendChat(transcript, root, projectDir)
  const seen = base.readJson(seenFile(), {})
  seen[`sent:${key}/${id}`] = sentStamp(stamp, ownCopy(projectDir, id))
  base.writeJson(seenFile(), seen)
  const result = isChanged ? { copied: id } : { same: id }
  return isGit && isChanged ? Object.assign(result, publish(store, `${id} from ${base.machineId()}`)) : result
}

// Brings each newer chat of this project into this computer's chat folder, then
// sends every chat of the project that changed here since it last went out (a
// copy cut short when a session ended goes now). The chat open in this session
// is never written.
function bringIn([chatDir, root, openId]) {
  const opened = openStore()
  if (!opened.store) return opened
  const { place, store } = opened
  const isGit = place.kind === 'git'
  const pulled = isGit ? pull(store) : {}
  const key = base.projectKey(root)
  const dir = path.join(store, key)
  const seen = base.readJson(seenFile(), {})
  const result = { imported: [], conflicts: [], behind: [], sent: [] }
  if (pulled.error) result.error = pulled.error
  for (const id of chatIds(dir)) {
    const answer = bringChat(path.join(dir, id), path.join(chatDir, `${id}.jsonl`), root,
      { isOpen: id === openId, seen, key: `${key}/${id}` })
    if (answer.verdict === 'imported') result.imported.push(id)
    if (answer.verdict === 'open') result.behind.push(id)
    if (answer.isConflict) result.conflicts.push(id)
  }
  const refused = isGit ? privateRepoError(place.repo) : null
  if (refused) result.error = result.error ? `${result.error} ${refused}` : refused
  for (const name of refused ? [] : chatFiles(chatDir)) {
    const local = path.join(chatDir, name)
    const id = name.slice(0, -'.jsonl'.length)
    const sentKey = `sent:${key}/${id}`
    const stamp = stampOf(local)
    if (seen[sentKey] === sentStamp(stamp, ownCopy(dir, id))) continue
    if (sendChat(local, root, dir)) result.sent.push(id)
    seen[sentKey] = sentStamp(stamp, ownCopy(dir, id))
  }
  base.writeJson(seenFile(), seen)
  if (isGit && !refused) Object.assign(result, publish(store, `${result.sent.length} chats from ${base.machineId()}`))
  return result
}

// Brings in the longest other computer's copy of one chat that extends this
// computer's chat. A copy that both changed is left where it is, in the sync
// place, and this computer's chat is kept. A chat this computer once had and
// no longer has was deleted here (by the user, or when Claude Code cleared out
// old chats), so it comes back only once another computer has continued it.
function bringChat(storeChat, local, root, { isOpen, seen, key }) {
  const copies = otherCopies(storeChat)
  const hasLocal = sizeOf(local) >= 0
  const wasDeleted = !hasLocal && seen[`sent:${key}`] !== undefined
  const isUnchanged = copies.every(copy => seen[`${key}/${path.basename(copy)}`] === stampOf(copy))
  const isSentHere = isPlainFile(path.join(storeChat, ownName()))
  if ((hasLocal || (wasDeleted && isSentHere)) && isUnchanged) return { verdict: 'kept' }
  if (wasDeleted && !isContinuedElsewhere(storeChat, root)) {
    markSeen(copies, seen, key)
    return { verdict: 'kept' }
  }
  const before = hasLocal ? stampOf(local) : null
  return inWorkFolder(work => {
    const found = behindCopy(storeChat, local, root, work)
    const answer = { verdict: found.read ? 'imported' : 'kept', isConflict: found.isConflict }
    if (found.read && isOpen) return { ...answer, verdict: 'open' }
    if (found.read && !importCopy(found.read, local, root, { localLines: found.localLines, before })) {
      return { ...answer, verdict: 'kept' }
    }
    // Marked as looked at only once done, so an import given up on is tried again.
    markSeen(copies, seen, key)
    return answer
  })
}

// Records each copy's stamp, so an unchanged one is not read again.
function markSeen(copies, seen, key) {
  for (const copy of copies) seen[`${key}/${path.basename(copy)}`] = stampOf(copy)
}

// True when another computer's copy holds lines after the ones this computer
// last sent, read in this computer's own paths. Without this computer's copy
// there is nothing to measure against, so any other copy counts.
function isContinuedElsewhere(storeChat, root) {
  return inWorkFolder(work => {
    const sent = path.join(work, 'sent')
    if (!copyPlainFile(path.join(storeChat, ownName()), sent)) return otherCopies(storeChat).length > 0
    const asLocal = path.join(work, 'sent-here')
    transformFile(sent, asLocal, expand(root, os.homedir()), true)
    return behindCopy(storeChat, asLocal, root, work).read !== undefined
  })
}

// The longest other computer's copy that this computer's chat is behind, read
// into `work`, and whether a copy before it changed on both computers.
function behindCopy(storeChat, local, root, work) {
  let isConflict = false
  const hasLocal = sizeOf(local) >= 0
  for (const { read } of readCopies(storeChat, work)) {
    const { verdict, localLines } = hasLocal ? compareChat(local, read, root) : { verdict: 'behind', localLines: 0 }
    if (verdict === 'diverged') isConflict = true
    if (verdict === 'behind') return { read, localLines, isConflict }
  }
  return { isConflict }
}

// Writes the local chat as its own complete lines plus the copy's lines after
// them; a last line cut off mid-write is dropped, since the copy's next line
// takes its place. When the chat changed since `before`, its stamp when the
// compare began (another session on this computer wrote it), nothing is
// written. True when the chat was written.
function importCopy(copy, local, root, { localLines, before }) {
  fs.mkdirSync(path.dirname(local), { recursive: true })
  const incoming = `${local}.chat-sync.${process.pid}.in`
  removeQuietly(incoming)
  if (before) transformFile(local, incoming, text => text, true)
  appendLines(copy, localLines, incoming, expand(root, os.homedir()))
  if ((sizeOf(local) >= 0 ? stampOf(local) : null) !== before) {
    removeQuietly(incoming)
    return false
  }
  fs.renameSync(incoming, local)
  return true
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
  const chats = store && key ? chatIds(path.join(store, key)).length : 0
  // Read only: setup asks for the status before the user agreed to any write.
  const machine = base.readJson(path.join(base.dataDir(), 'machine.json'), {}).id || null
  return { place, machine, project: key, chats, git: hasGit() }
}

function hasGit() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
}

module.exports = { run, out, bringIn, compare, publish, pull, chatFiles, chatIds, ensureFolder, isLink }

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
const { withRunLock, isAlive } = require('./lock.cjs')

// The hook stops a copy's helper after 120 s and a move's after 300 s, and
// passes the moment its answer is due in CHAT_SYNC_DEADLINE. These are the
// limits when no deadline is passed, as for the copy a session's end starts.
const COPY_LIMIT_MS = 110_000
const MOVE_LIMIT_MS = 290_000

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
// readers accept, whatever machine.json holds.
function ownName() {
  return copyName(base.machineId())
}

// The name of a computer's copy of a chat in the sync place.
function copyName(machine) {
  return `${machine.replace(/[^\w-]+/g, '-')}.jsonl`
}

// A temporary copy of this computer's, named the way sync apps name theirs.
function tempOf(own) {
  return path.join(path.dirname(own), `.${path.basename(own)}.${process.pid}.tmp`)
}

// Removes temporary copies this computer left in a chat's folder, from a helper
// stopped before it renamed them. One younger than a helper's longest run may
// belong to another session's helper still writing it, so it stays.
const TEMP_STALE_MS = 5 * 60_000
// A session start's helper is stopped at 120 s, so its lock wait and chats get
// 40 s and the privacy check, commit, pull and push the rest;
// CHAT_SYNC_RUN_BUDGET_MS sets another budget.
const RUN_BUDGET_MS = 40_000

function runBudgetMs() {
  const set = process.env.CHAT_SYNC_RUN_BUDGET_MS
  return set && Number(set) >= 0 ? Number(set) : RUN_BUDGET_MS
}

function sweepTemps(own) {
  const prefix = `.${path.basename(own)}.`
  for (const name of fs.readdirSync(path.dirname(own))) {
    const file = path.join(path.dirname(own), name)
    if (name.startsWith(prefix) && name.endsWith('.tmp') && isLeftOver(file)) removeQuietly(file)
  }
}

// True when what sits at `file` should go: anything but a plain file, or one
// older than a helper's longest run. A name another helper removed meanwhile
// is left alone.
function isLeftOver(file) {
  try {
    const entry = fs.lstatSync(file)
    return !entry.isFile() || Date.now() - entry.mtimeMs > TEMP_STALE_MS
  } catch {
    return false
  }
}

// Puts a copy of `built` at `dest` through an exclusive temporary file renamed
// over it, so a link planted at either name is replaced, never written through.
function placeFile(built, dest) {
  const next = tempOf(dest)
  removeQuietly(next)
  fs.copyFileSync(built, next, fs.constants.COPYFILE_EXCL)
  fs.renameSync(next, dest)
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

// Private copies of chats live in the helper's own folder, never the system's
// temporary one, each named after the run's process, and each run clears what
// a stopped run left there.
function workRoot() {
  return path.join(base.dataDir(), 'work')
}

const WORK_FOLDER = /^run-(\d+)-/

function clearStoppedRuns() {
  let names = []
  try {
    names = fs.readdirSync(workRoot())
  } catch {
    return
  }
  for (const name of names) {
    const owner = Number(WORK_FOLDER.exec(name)?.[1])
    if (!owner || !isAlive(owner)) removeQuietly(path.join(workRoot(), name))
  }
}

// Runs `work` with a private folder of this computer's, removed after.
function inWorkFolder(work) {
  fs.mkdirSync(workRoot(), { recursive: true })
  const dir = fs.mkdtempSync(path.join(workRoot(), `run-${process.pid}-`))
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

// Clears whatever sits at a name this computer writes unless it is a plain
// file, so a link, pipe or folder planted there is never read or followed.
function clearUnlessPlain(file) {
  let entry
  try {
    entry = fs.lstatSync(file)
  } catch {
    return
  }
  if (!entry.isFile()) removeQuietly(file)
}

// One run at a time works in the clone (lock.cjs), and each git call is stopped
// within a minute, so a lock older than TEMP_STALE_MS was left by a git that
// was stopped while it held it.
function clearStaleLock(store) {
  const lock = path.join(store, '.git', 'index.lock')
  let entry
  try {
    entry = fs.lstatSync(lock)
  } catch {
    return
  }
  if (Date.now() - entry.mtimeMs > TEMP_STALE_MS) removeQuietly(lock)
}

// Commits what this computer wrote, brings the clone up to the repo and pushes.
function publish(store, label) {
  clearStaleLock(store)
  const add = base.git(store, 'add', '-A')
  if (!add.ok) return { pushError: add.out }
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
// into it while its index holds anything, so its index goes instead. Returns
// git's words when the clone could not be cleared.
function dropUncommitted(store) {
  if (base.git(store, 'rev-parse', '--verify', '-q', 'HEAD').ok) {
    const reset = base.git(store, 'reset', '--hard', '-q')
    if (!reset.ok) return reset.out
  } else {
    removeQuietly(path.join(store, '.git', 'index'))
  }
  const clean = base.git(store, 'clean', '-fdq')
  return clean.ok ? null : clean.out
}

// The repo's default branch as { branch }, {} while nothing has been pushed to
// it, or { error } when the repo could not be read: git answers an empty repo
// with success and nothing listed, and an unreachable one with a failure.
function remoteBranch(store) {
  const head = base.git(store, 'ls-remote', '--symref', 'origin', 'HEAD')
  if (!head.ok) return { error: head.out }
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.out)
  return match ? { branch: match[1] } : {}
}

// Whether the clone holds commits the repo lacks, such as those of a push that
// failed, so the next copy pushes them though its own chat did not change.
function isAhead(store) {
  const count = base.git(store, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin')
  return count.ok && Number(count.out) > 0
}

// A rebase in progress leaves its folder in the clone, in whatever language git speaks.
function isRebasing(store) {
  return ['rebase-merge', 'rebase-apply'].some(name => fs.existsSync(path.join(store, '.git', name)))
}

// Brings the clone up to the repo, naming the branch, so a clone made while the
// repo was empty catches up too. Files never committed (a copy cut short) are
// dropped first: each is this computer's own and is written again from its chat
// folder. Every commit touches only its own computer's files, so a pull whose
// rebase still conflicts is reset to the repo's copy, and this computer's next
// copy out writes its files again. Any other failure keeps the local commits.
function pull(store) {
  clearStaleLock(store)
  // A run stopped in the middle of a pull left its rebase half done; undoing it
  // puts back the commits it was replaying. Only one run works in the clone.
  if (isRebasing(store)) base.git(store, 'rebase', '--abort')
  const dropped = dropUncommitted(store)
  if (dropped) return { error: dropped }
  const remote = remoteBranch(store)
  if (remote.error) return { error: remote.error }
  const { branch } = remote
  if (!branch) return {}
  // Named in full, so a branch the repo names with a leading dash is never read as an option.
  const run = base.git(store, 'pull', '-q', '--rebase', 'origin', `refs/heads/${branch}`)
  if (run.ok) return { branch }
  // A rebase stopped on a conflict is still in progress; a network or sign-in
  // failure stops before it starts.
  const isConflict = isRebasing(store)
  base.git(store, 'rebase', '--abort')
  if (!isConflict) return { error: run.out }
  const reset = base.git(store, 'reset', '--hard', '-q', `origin/${branch}`)
  return { error: reset.ok ? CHANGED_MEANWHILE : reset.out }
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
// Sets the clone's own git files, which outrank the repo's and the user's:
// temporaries stay out of commits, and no attribute (a global `* text=auto`,
// a committed .gitattributes) changes a chat file's line ends.
function fitClone(store) {
  addLine(path.join(store, '.git', 'info', 'exclude'), '.*.tmp')
  addLine(path.join(store, '.git', 'info', 'attributes'), '* -text')
}

function addLine(file, line) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (text.split('\n').includes(line)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`)
}

const NO_GIT = 'The chats sync through a git repo here, but this session cannot find git, so nothing was copied. '
  + 'Install git, or make sure it is on the PATH Claude Code starts with.'

// Where the chats go now, or a reason nothing can be copied. Every git call
// in the clone runs with the mod's own settings (`gitSettings` in sync.cjs).
function openStore() {
  const place = base.readPlace()
  const store = base.storeRoot(place)
  if (!store) return { skipped: 'off' }
  // A sync folder that is gone (the app unlinked, a drive not mounted) is never
  // made again here, since chats written there would reach no other computer.
  if (place.kind === 'folder' && !fs.statSync(store, { throwIfNoEntry: false })?.isDirectory()) {
    return { error: `The sync folder ${store} is missing. Check that the sync app is running, `
      + 'or pick another place with /chat-sync move folder <path>.' }
  }
  if (place.kind === 'git') {
    if (!fs.existsSync(path.join(store, '.git'))) {
      return { error: 'The chat repo is not cloned here. Run /chat-sync move git <owner/repo> again.' }
    }
    // Checked before anything is written: with no git, the project's remote
    // cannot be read either, and a chat left in the clone under another name
    // would go up with the next run that finds git.
    const check = base.git(store, '--version')
    if (!check.ok) return { error: check.isMissing ? NO_GIT : check.out }
    const recorded = base.cloneOf(store)
    if (recorded !== null && recorded !== place.repo) {
      return { error: `The clone here is not of ${place.repo}, since a move stopped halfway. `
        + `Run /chat-sync move git ${place.repo} again.` }
    }
    fitClone(store)
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
// `work`, longest first, as { copy, read }; one that is no plain file is left
// out. A plain file that cannot be read (a sync app holding it, a file kept
// online only) stops the chat, so it is not marked as looked at and is tried
// again at the next run.
function* readCopies(folder, work) {
  for (const [at, copy] of otherCopies(folder).entries()) {
    const read = path.join(work, `copy-${at}`)
    if (copyPlainFile(copy, read)) yield { copy, read }
    else if (isPlainFile(copy)) throw new Error(`could not read ${copy}; it is tried again at the next run`)
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
    clearUnlessPlain(own)
    if (compare(built, own) === 'same') return false
    placeFile(built, own)
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

function endsOnWholeLine(file) {
  const size = sizeOf(file)
  if (size <= 0) return size === 0
  const input = fs.openSync(file, 'r')
  try {
    const last = Buffer.alloc(1)
    fs.readSync(input, last, 0, 1, size - 1)
    return last[0] === 10
  } finally {
    fs.closeSync(input)
  }
}

function stampOf(file) {
  const stat = fs.statSync(file)
  return `${stat.size}:${Math.round(stat.mtimeMs)}`
}

// Why this computer's chats of `root` cannot sync, or null. Each path is swapped
// as plain text, which is exact only for a folder name JSON writes unescaped.
function unsyncable(root) {
  const folder = paths.escapedFolder(root, os.homedir())
  if (!folder) return null
  return `rename the folder ${folder} to sync this project's chats, which stay on this computer `
    + 'while its name holds a quote, a backslash or a control character'
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
  // Said once, at session start, by `in`.
  if (unsyncable(root)) return { skipped: 'folder name' }
  const id = path.basename(transcript, '.jsonl')
  const key = base.projectKey(root)
  const projectDir = path.join(store, key)
  const stamp = stampOf(transcript)
  const isChanged = sendChat(transcript, root, projectDir)
  const seen = base.readJson(seenFile(), {})
  seen[`sent:${key}/${id}`] = sentStamp(stamp, ownCopy(projectDir, id))
  base.writeJson(seenFile(), seen)
  const result = isChanged ? { copied: id } : { same: id }
  const isToPush = isGit && (isChanged || isAhead(store))
  return isToPush ? Object.assign(result, publish(store, `${id} from ${base.machineId()}`)) : result
}

// Brings each newer chat of this project into this computer's chat folder, then
// sends every chat of the project that changed here since it last went out (a
// copy cut short when a session ended goes now). The chat open in this session
// is never written.
function bringIn([chatDir, root, openId]) {
  const opened = openStore()
  if (!opened.store) return opened
  const { place, store } = opened
  const unsafe = unsyncable(root)
  if (unsafe) return { refused: unsafe }
  const isGit = place.kind === 'git'
  // Counted from the helper's start, so a wait for another run's lock uses it too.
  const deadline = performance.timeOrigin + runBudgetMs()
  const pulled = isGit ? pull(store) : {}
  const key = base.projectKey(root)
  const dir = path.join(store, key)
  const seen = base.readJson(seenFile(), {})
  const result = { imported: [], conflicts: [], behind: [], sent: [] }
  if (pulled.error) addError(result, pulled.error)
  sweepImports(chatDir)
  forEachChat(chatIds(dir), result, id => {
    const answer = bringChat(path.join(dir, id), path.join(chatDir, `${id}.jsonl`), root,
      { isOpen: id === openId, seen, key: `${key}/${id}` })
    if (answer.verdict === 'imported') result.imported.push(id)
    if (answer.verdict === 'open') result.behind.push(id)
    if (answer.isConflict) result.conflicts.push(id)
  }, deadline)
  const refused = isGit ? privateRepoError(place.repo) : null
  if (refused) addError(result, refused)
  const localIds = refused ? [] : chatFiles(chatDir).map(name => name.slice(0, -'.jsonl'.length))
  forEachChat(localIds, result, id => {
    const local = path.join(chatDir, `${id}.jsonl`)
    const sentKey = `sent:${key}/${id}`
    const stamp = stampOf(local)
    if (seen[sentKey] === sentStamp(stamp, ownCopy(dir, id))) return
    if (sendChat(local, root, dir)) result.sent.push(id)
    seen[sentKey] = sentStamp(stamp, ownCopy(dir, id))
  }, deadline)
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
  // Stamps taken before any copy is read, so a copy that changes meanwhile
  // reads as changed at the next start.
  const stamps = copies.map(copy => [copy, stampOf(copy)])
  const hasLocal = sizeOf(local) >= 0
  const wasDeleted = !hasLocal && seen[`sent:${key}`] !== undefined
  const isUnchanged = stamps.every(([copy, stamp]) => seen[`${key}/${path.basename(copy)}`] === stamp)
  const isSentHere = isPlainFile(path.join(storeChat, ownName()))
  if ((hasLocal || (wasDeleted && isSentHere)) && isUnchanged) return { verdict: 'kept' }
  if (wasDeleted && !isContinuedElsewhere(storeChat, root)) {
    markSeen(stamps, seen, key)
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
    markSeen(stamps, seen, key)
    return answer
  })
}

// Records each copy's stamp, so an unchanged one is not read again.
function markSeen(stamps, seen, key) {
  for (const [copy, stamp] of stamps) seen[`${key}/${path.basename(copy)}`] = stamp
}

// Runs `step` for each chat id; one that fails is named in the answer's error
// and the others still go.
// Stops at the run's deadline and says so, so a run with more chats than its
// time allows still saves and pushes what it did, and the next start goes on.
function forEachChat(ids, result, step, deadline) {
  for (const id of ids) {
    if (Date.now() > deadline) {
      result.more = true
      return
    }
    try {
      step(id)
    } catch (error) {
      addError(result, `${id}: ${error.message}`)
    }
  }
}

function addError(result, text) {
  result.error = result.error ? `${result.error} ${text}` : text
}

// The temporary file an import builds beside the chat it replaces.
const IMPORT_TEMP = /\.jsonl\.chat-sync\.\d+\.in$/

// Removes import files a helper stopped before it renamed them. One younger
// than a helper's longest run may still be written, so it stays.
function sweepImports(chatDir) {
  let names = []
  try {
    names = fs.readdirSync(chatDir)
  } catch {
    return
  }
  for (const name of names.filter(entry => IMPORT_TEMP.test(entry))) {
    if (isLeftOver(path.join(chatDir, name))) removeQuietly(path.join(chatDir, name))
  }
}

// True when another computer's copy holds lines after the ones this computer
// last sent, read in this computer's own paths. Without this computer's copy
// there is nothing to measure against, so any other copy counts.
function isContinuedElsewhere(storeChat, root) {
  return inWorkFolder(work => {
    const sent = path.join(work, 'sent')
    const own = path.join(storeChat, ownName())
    if (!copyPlainFile(own, sent)) {
      if (isPlainFile(own)) throw new Error(`could not read ${own}; it is tried again at the next run`)
      return otherCopies(storeChat).length > 0
    }
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

// Adds the copy's lines after the local chat's own. A chat that ends on a
// whole line gets them appended in place, so a line another session on this
// computer writes meanwhile lands beside them instead of being written over.
// A chat whose last line was cut off mid-write is rebuilt from its complete
// lines plus the copy's, since the copy's next line takes the cut one's place.
// When the chat changed since `before`, its stamp when the compare began,
// nothing is written. True when the chat was written.
function importCopy(copy, local, root, { localLines, before }) {
  fs.mkdirSync(path.dirname(local), { recursive: true })
  const incoming = `${local}.chat-sync.${process.pid}.in`
  removeQuietly(incoming)
  try {
    const isWhole = before !== null && endsOnWholeLine(local)
    if (before && !isWhole) transformFile(local, incoming, text => text, true)
    appendLines(copy, localLines, incoming, expand(root, os.homedir()))
    if ((sizeOf(local) >= 0 ? stampOf(local) : null) !== before) return false
    if (isWhole) appendLines(incoming, 0, local, text => text)
    else fs.renameSync(incoming, local)
    return true
  } finally {
    removeQuietly(incoming)
  }
}

// The run's deadline: the one the hook passed, else `limitMs` from the
// helper's start. The lock wait and every git and gh call fit in it, so the
// answer is printed before the hook stops the helper.
function runDeadline(limitMs) {
  const own = performance.timeOrigin + limitMs
  const given = Number(process.env.CHAT_SYNC_DEADLINE)
  return given > 0 ? Math.min(own, given) : own
}

// The run holding the lock clears the work folders of runs that are gone.
function locked(work, limitMs) {
  base.setDeadline(runDeadline(limitMs))
  return withRunLock(() => {
    clearStoppedRuns()
    return work()
  })
}

function run([command, ...args]) {
  const { move } = require('./move.cjs')
  const copyLimitMs = Number(process.env.CHAT_SYNC_COPY_LIMIT_MS) || COPY_LIMIT_MS
  if (command === 'out') return locked(() => out(args), copyLimitMs)
  if (command === 'in') return locked(() => bringIn(args), copyLimitMs)
  if (command === 'move') return locked(() => move(args), MOVE_LIMIT_MS)
  if (command === 'places') return places()
  if (command === 'status') return status(args)
  return { error: `Unknown command: ${command || '(none)'}` }
}

// Each sync folder found here, with what other computers keep in its
// `Claude chats` folder (`others`, null when nothing), so setup can offer the
// place a second computer joins. Read only, like `status`; a machine file
// that cannot be read leaves every copy counted as another computer's.
function places() {
  let machine = null
  try {
    const id = base.readJson(path.join(base.dataDir(), 'machine.json'), {}).id
    if (typeof id === 'string' && id) machine = copyName(id).slice(0, -'.jsonl'.length)
  } catch {
    // Read again by the first copy, which says what is wrong with it.
  }
  const found = syncPlaces().map(place => {
    const others = othersChats(path.join(place.path, 'Claude chats'), machine)
    return { ...place, others }
  })
  return { places: found }
}

// The computer a copy in the sync place belongs to, a copy a move kept aside
// (`<computer>-moved-<time>.jsonl`) included.
function computerOf(copy) {
  return copy.slice(0, -'.jsonl'.length).replace(/(-moved-\d+)+$/, '')
}

// What other computers keep in the store `chats`, read the way a sync reads
// a store, so no link is followed: the number of projects and some of the
// computers' names, or null when it holds no copy but `ownMachine`'s or cannot
// be read (an offline cloud folder, a folder the app keeps private). A project
// counts at its first chat that holds another computer's copy, so a large
// store stays quick, and the names are the computers in those chats only.
function othersChats(chats, ownMachine) {
  const computers = new Set()
  let projects = 0
  try {
    if (!isRealFolder(chats)) return null
    for (const project of projectFolders(chats)) {
      for (const id of chatIds(path.join(chats, project))) {
        const others = chatFiles(path.join(chats, project, id)).map(computerOf).filter(name => name !== ownMachine)
        if (!others.length) continue
        projects += 1
        for (const name of others) computers.add(name)
        break
      }
    }
  } catch {
    return null
  }
  return projects ? { folder: chats, projects, computers: [...computers].sort() } : null
}

// The project folders of a store: plain folders not named with a leading dot.
function projectFolders(store) {
  if (!store || !fs.existsSync(store)) return []
  return fs.readdirSync(store, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
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

module.exports = {
  run, out, bringIn, compare, publish, pull, remoteBranch, chatFiles, chatIds, ensureFolder, clearUnlessPlain,
  placeFile, inWorkFolder, fitClone, projectFolders, othersChats,
}

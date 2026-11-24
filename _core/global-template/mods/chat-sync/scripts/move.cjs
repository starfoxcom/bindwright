// Moves every synced chat from the current sync place to a new one, checks
// that each arrived, then switches. The old place keeps its copy until the
// user deletes it.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const base = require('./sync.cjs')
const {
  compare, publish, pull, remoteBranch, chatFiles, chatIds, ensureFolder, clearUnlessPlain, placeFile, inWorkFolder,
} = require('./commands.cjs')
const { copyPlainFile } = require('./paths.cjs')

// Neither part starts with a dash, so gh never reads the name as an option.
const REPO = /^[\w.][\w.-]*\/[\w.][\w.-]*$/
const GH_TIMEOUT_MS = 30_000

function describe(place) {
  if (place.kind === 'folder') return place.path
  if (place.kind === 'git') return `github.com/${place.repo}`
  return 'off'
}

// A chat repo must be private: a chat holds code, command output and anything pasted in.
function checkPrivate(repo) {
  const view = base.timedRun('gh', ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'], GH_TIMEOUT_MS)
  if (!view) return base.OUT_OF_TIME
  if (view.status !== 0) {
    return `Could not confirm that ${repo} is private: ${(view.stderr || '').trim() || base.stopReason('gh', view)}`
  }
  const visibility = view.stdout.trim()
  if (visibility === 'PRIVATE') return null
  return `${repo} is ${visibility.toLowerCase() || 'not confirmed private'}, and chats go only to a private repo.`
}

// The repo's address as gh would clone it: its ssh address when gh's git
// protocol is ssh, else its https one.
function repoAddress(repo) {
  const protocol = base.timedRun('gh', ['config', 'get', 'git_protocol', '-h', 'github.com'], GH_TIMEOUT_MS)
  if (!protocol) return { error: base.OUT_OF_TIME }
  const field = (protocol.stdout || '').trim() === 'ssh' ? 'sshUrl' : 'url'
  const view = base.timedRun('gh', ['repo', 'view', repo, '--json', field, '--jq', `.${field}`], GH_TIMEOUT_MS)
  if (!view) return { error: base.OUT_OF_TIME }
  const address = (view.stdout || '').trim()
  if (view.status === 0 && address) return { address }
  return { error: `Could not find ${repo}: ${(view.stderr || '').trim() || base.stopReason('gh', view)}` }
}

// Made the way git reads its settings: the remote is set before anything is
// fetched, so a setting the user keeps for that address (a conditional include
// with a per-account ssh key) applies from the first fetch. Every call runs
// with the mod's own git settings, the checkout's line ends included.
function clone(repo, folder) {
  fs.rmSync(folder, { recursive: true, force: true })
  const found = repoAddress(repo)
  if (found.error) return found.error
  fs.mkdirSync(folder, { recursive: true })
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', found.address], ['fetch', '-q', 'origin']]) {
    const run = base.git(folder, ...args)
    if (!run.ok) return `Could not clone ${repo}: ${run.out}`
  }
  // Inside .git, so never committed: which repo this clone is, checked at every
  // run, so a move stopped between its switch steps never pushes to the wrong one.
  fs.writeFileSync(path.join(folder, '.git', base.CLONE_OF), repo)
  const remote = remoteBranch(folder)
  if (remote.error) return `Could not clone ${repo}: ${remote.error}`
  if (!remote.branch) return null
  const checkout = base.git(folder, 'checkout', '-q', '-B', remote.branch, `refs/remotes/origin/${remote.branch}`)
  return checkout.ok ? null : `Could not clone ${repo}: ${checkout.out}`
}

function isInside(folder, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(folder))
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

// The project folders in a sync place, each holding chat files.
function projectFolders(store) {
  if (!store || !fs.existsSync(store)) return []
  return fs.readdirSync(store, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
}

// Copies every computer's copy of each chat into `to`. Where `to` already holds
// that copy, the newer one wins, and two that both changed are both kept, the
// one moved in beside the other as `<computer>-moved-<time>.jsonl`, which every
// computer then reads as one more copy of the chat.
function copyChats(from, to) {
  let moved = 0
  const missing = []
  // A new place inside the old one is not one of its projects.
  const projects = projectFolders(from).filter(name => !isInside(to, path.join(from, name)))
  for (const project of projects) {
    for (const id of chatIds(path.join(from, project))) {
      // A folder with no chat file is not a chat, so nothing is made or counted for it.
      const names = chatFiles(path.join(from, project, id))
      if (!names.length) continue
      const target = path.join(to, project, id)
      ensureFolder(path.join(to, project))
      ensureFolder(target)
      for (const name of names) {
        const isCopied = copyOne(path.join(from, project, id, name), target, name)
        if (!isCopied) missing.push(`${project}/${id}/${name}`)
      }
      moved += 1
    }
  }
  return { moved, missing }
}

// Copies one computer's copy into `target`. The old place's copy is read once,
// through a checked handle, into a private folder, and everything after works
// from that read. True when the copy is in `target`.
function copyOne(source, target, name) {
  return inWorkFolder(work => {
    const read = path.join(work, 'copy')
    if (!copyPlainFile(source, read)) return false
    const dest = path.join(target, name)
    clearUnlessPlain(dest)
    const verdict = compare(read, dest)
    if (verdict === 'new' || verdict === 'ahead') placeFile(read, dest)
    const keptName = name.replace(/\.jsonl$/, `-moved-${Date.now()}.jsonl`)
    if (verdict === 'diverged') placeFile(read, path.join(target, keptName))
    return fs.existsSync(dest)
  })
}

// A folder as the user typed it, with a leading ~ as their home folder, or null
// for a relative path: the helper's working folder is often the project, and
// chats kept there would land in its commits.
function fullPath(where) {
  const expanded = where.replace(/^~(?=$|[\\/])/, os.homedir())
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null
}

// The new place and the folder chats are copied into, or a reason to stop.
function prepare(kind, where) {
  if (kind === 'folder') {
    const folder = fullPath(where || '')
    if (!folder) return { error: 'Name the chats folder by its full path, such as ~/Dropbox/Claude chats.' }
    fs.mkdirSync(folder, { recursive: true })
    return { place: { kind: 'folder', path: folder }, store: folder }
  }
  if (kind === 'git') {
    if (!REPO.test(where || '')) return { error: 'Name the repo as owner/repo.' }
    const refused = checkPrivate(where)
    if (refused) return { error: refused }
    const next = path.join(base.dataDir(), 'repo-next')
    const failed = clone(where, next)
    return failed ? { error: failed } : { place: { kind: 'git', repo: where }, store: next }
  }
  return { error: 'Use: move folder <path>, move git <owner/repo> or move off.' }
}

// The git place always lives at repo/; a new clone takes that name once the
// chats are copied, and an old one is renamed aside, never deleted.
function settleClone(place) {
  if (place.kind !== 'git') return
  const repo = base.storeRoot(place)
  const old = `${repo}-old-${Date.now()}`
  const hadOld = fs.existsSync(repo)
  if (hadOld) fs.renameSync(repo, old)
  try {
    fs.renameSync(path.join(base.dataDir(), 'repo-next'), repo)
  } catch (error) {
    // The old clone goes back, so the old place stays in use.
    if (hadOld) fs.renameSync(old, repo)
    throw error
  }
}

// A git place whose clone is gone (deleted, or a move cut short) is cloned
// again by a move to the same repo.
function isCloneMissing(place) {
  return place.kind === 'git' && !fs.existsSync(path.join(base.storeRoot(place), '.git'))
}

// A move carries the chats out of the old place, so one that cannot be read
// stops it before anything is made or cloned. A move to the same repo is how a
// missing clone comes back.
function unreadableOld(old, kind, where) {
  if (old.kind === 'folder' && !fs.statSync(old.path, { throwIfNoEntry: false })?.isDirectory()) {
    return `The chats were not moved, since the sync folder ${old.path} is missing. Check that the sync app `
      + 'is running, or run /chat-sync move off first to start over in the new place.'
  }
  if (isCloneMissing(old) && !(kind === 'git' && where === old.repo)) {
    return `The chats were not moved, since the clone of ${describe(old)} is missing. `
      + `Run /chat-sync move git ${old.repo} to clone it again, then move.`
  }
  return null
}

function move([kind, where]) {
  const old = base.readPlace()
  const placeFile = path.join(base.dataDir(), 'place.json')
  if (kind === 'off') {
    base.writeJson(placeFile, { kind: 'off' })
    return { moved: 0, from: describe(old), to: 'off' }
  }
  const unreadable = unreadableOld(old, kind, where)
  if (unreadable) return { error: unreadable }
  const ready = prepare(kind, where)
  if (ready.error) return ready
  if (describe(ready.place) === describe(old) && !isCloneMissing(old)) {
    return { error: `The chats already sync through ${describe(old)}.` }
  }
  // A clone holds only what it last pulled, so the newest copies come down first.
  if (old.kind === 'git' && !isCloneMissing(old)) {
    const pulled = pull(base.storeRoot(old))
    if (pulled.error) {
      return { error: `The chats were not moved, since the chat repo could not be read: ${pulled.error}` }
    }
  }
  const copied = copyChats(base.storeRoot(old), ready.store)
  if (copied.missing.length) return { error: `These chats did not arrive: ${copied.missing.join(', ')}` }
  // A repo holds the copies only once they are pushed, so the place switches
  // after that, and the old place stays in use when the push fails.
  const pushed = ready.place.kind === 'git' ? publish(ready.store, `move ${copied.moved} chats in`) : {}
  if (pushed.pushError) {
    return { error: `The chats still sync where they did, since the repo did not take them: ${pushed.pushError}` }
  }
  settleClone(ready.place)
  base.writeJson(placeFile, ready.place)
  return { moved: copied.moved, from: describe(old), to: describe(ready.place), ...pushed }
}

module.exports = { move, describe, checkPrivate }

// Moves every synced chat from the current sync place to a new one, checks
// that each arrived, then switches. The old place keeps its copy until the
// user deletes it.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const base = require('./sync.cjs')
const {
  compare, publish, chatFiles, chatIds, ensureFolder, clearUnlessPlain, placeFile, inWorkFolder,
} = require('./commands.cjs')
const { copyPlainFile } = require('./paths.cjs')

// Neither part starts with a dash, so gh never reads the name as an option.
const REPO = /^[\w.][\w.-]*\/[\w.][\w.-]*$/

function describe(place) {
  if (place.kind === 'folder') return place.path
  if (place.kind === 'git') return `github.com/${place.repo}`
  return 'off'
}

// A chat repo must be private: a chat holds code, command output and anything pasted in.
function checkPrivate(repo) {
  const view = spawnSync('gh', ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'],
    { encoding: 'utf8', timeout: 30_000, env: base.quietEnv() })
  if (view.status !== 0) {
    return `Could not confirm that ${repo} is private: ${(view.stderr || '').trim() || base.stopReason('gh', view)}`
  }
  const visibility = view.stdout.trim()
  if (visibility === 'PRIVATE') return null
  return `${repo} is ${visibility.toLowerCase() || 'not confirmed private'}, and chats go only to a private repo.`
}

// The clone gets the mod's own git settings from its first checkout on.
function clone(repo, folder) {
  fs.rmSync(folder, { recursive: true, force: true })
  const args = ['repo', 'clone', repo, folder, '--', ...base.gitSettings()]
  const run = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, env: base.quietEnv() })
  return run.status === 0 ? null : `Could not clone ${repo}: ${(run.stderr || '').trim() || base.stopReason('gh', run)}`
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
// one moved in beside the other as `<computer>.moved`.
function copyChats(from, to) {
  let moved = 0
  const missing = []
  for (const project of projectFolders(from)) {
    for (const id of chatIds(path.join(from, project))) {
      const target = path.join(to, project, id)
      ensureFolder(path.join(to, project))
      ensureFolder(target)
      for (const name of chatFiles(path.join(from, project, id))) {
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
    if (verdict === 'diverged') placeFile(read, path.join(target, name.replace(/\.jsonl$/, '.moved')))
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
  if (fs.existsSync(repo)) fs.renameSync(repo, `${repo}-old-${Date.now()}`)
  fs.renameSync(path.join(base.dataDir(), 'repo-next'), repo)
}

// A git place whose clone is gone (deleted, or a move cut short) is cloned
// again by a move to the same repo.
function isCloneMissing(place) {
  return place.kind === 'git' && !fs.existsSync(path.join(base.storeRoot(place), '.git'))
}

function move([kind, where]) {
  const old = base.readPlace()
  const placeFile = path.join(base.dataDir(), 'place.json')
  if (kind === 'off') {
    base.writeJson(placeFile, { kind: 'off' })
    return { moved: 0, from: describe(old), to: 'off' }
  }
  const ready = prepare(kind, where)
  if (ready.error) return ready
  if (describe(ready.place) === describe(old) && !isCloneMissing(old)) {
    return { error: `The chats already sync through ${describe(old)}.` }
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

// Moves every synced chat from the current sync place to a new one, checks
// that each arrived, then switches. The old place keeps its copy until the
// user deletes it.
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const base = require('./sync.cjs')
const { compare, commitAndPush, chatFiles } = require('./commands.cjs')

const REPO = /^[\w.-]+\/[\w.-]+$/

function describe(place) {
  if (place.kind === 'folder') return place.path
  if (place.kind === 'git') return `github.com/${place.repo}`
  return 'off'
}

// A chat repo must be private: a chat holds code, command output and anything pasted in.
function checkPrivate(repo) {
  const view = spawnSync('gh', ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'],
    { encoding: 'utf8', timeout: 30_000 })
  if (view.status !== 0) return `Could not confirm that ${repo} is private: ${(view.stderr || '').trim()}`
  return view.stdout.trim() === 'PUBLIC' ? `${repo} is public, and chats must never go to a public repo.` : null
}

function clone(repo, folder) {
  fs.rmSync(folder, { recursive: true, force: true })
  const run = spawnSync('gh', ['repo', 'clone', repo, folder], { encoding: 'utf8', timeout: 120_000 })
  return run.status === 0 ? null : `Could not clone ${repo}: ${(run.stderr || '').trim()}`
}

// The project folders in a sync place, each holding chat files.
function projectFolders(store) {
  if (!store || !fs.existsSync(store)) return []
  return fs.readdirSync(store, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
}

// Copies each chat into `to`. Where `to` already holds that chat, the newer
// copy wins, and two copies that both changed are both kept.
function copyChats(from, to) {
  let moved = 0
  const missing = []
  for (const project of projectFolders(from)) {
    const target = path.join(to, project)
    fs.mkdirSync(target, { recursive: true })
    for (const name of chatFiles(path.join(from, project))) {
      const source = path.join(from, project, name)
      const dest = path.join(target, name)
      const verdict = compare(source, dest)
      if (verdict === 'new' || verdict === 'ahead') fs.copyFileSync(source, dest)
      if (verdict === 'diverged') keepBoth(source, target, name)
      if (!fs.existsSync(dest)) missing.push(`${project}/${name}`)
      moved += 1
    }
  }
  return { moved, missing }
}

function keepBoth(source, target, name) {
  const conflicts = path.join(target, 'conflicts')
  fs.mkdirSync(conflicts, { recursive: true })
  fs.copyFileSync(source, path.join(conflicts, name.replace(/\.jsonl$/, '.moved.jsonl')))
}

// The new place and the folder chats are copied into, or a reason to stop.
function prepare(kind, where) {
  if (kind === 'folder') {
    if (!where) return { error: 'Name the folder to keep the chats in.' }
    const folder = path.resolve(where)
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
  if (place.kind !== 'git') return base.storeRoot(place)
  const repo = base.storeRoot(place)
  if (fs.existsSync(repo)) fs.renameSync(repo, `${repo}-old-${Date.now()}`)
  fs.renameSync(path.join(base.dataDir(), 'repo-next'), repo)
  return repo
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
  if (describe(ready.place) === describe(old)) return { error: `The chats already sync through ${describe(old)}.` }
  const copied = copyChats(base.storeRoot(old), ready.store)
  if (copied.missing.length) return { error: `These chats did not arrive: ${copied.missing.join(', ')}` }
  const store = settleClone(ready.place)
  const pushed = ready.place.kind === 'git' ? commitAndPush(store, `move ${copied.moved} chats in`) : {}
  base.writeJson(placeFile, ready.place)
  return { moved: copied.moved, from: describe(old), to: describe(ready.place), ...pushed }
}

module.exports = { move, describe }

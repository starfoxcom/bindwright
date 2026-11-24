// Run: node --test test-helper/places.spec.cjs
// The sync folders setup offers, and what other computers keep in them.
'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRIPTS = path.join(__dirname, '..', 'scripts')

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `chat-sync-${name}-`))
}

test('Google Drive is found under its folder name in the computer\'s language', () => {
  const { syncPlaces } = require(path.join(SCRIPTS, 'places.cjs'))
  for (const name of ['My Drive', 'Mi unidad', 'Meine Ablage']) {
    const home = tempDir('home')
    fs.mkdirSync(path.join(home, name))
    const drive = syncPlaces(home).find(place => place.service === 'Google Drive')
    assert.strictEqual(drive && drive.path, path.join(home, name), name)
  }
})

// A chats folder whose one project holds chat s1 with the given copies.
function withCopies(copies) {
  const chats = path.join(tempDir('drive'), 'Claude chats')
  fs.mkdirSync(path.join(chats, 'shop-1', 's1'), { recursive: true })
  for (const copy of copies) fs.writeFileSync(path.join(chats, 'shop-1', 's1', copy), '{}\n')
  return chats
}

test('a sync folder where another computer keeps chats is told apart from one with none', () => {
  const { othersChats } = require(path.join(SCRIPTS, 'commands.cjs'))
  const projectLink = withCopies([])
  fs.symlinkSync(path.join(withCopies(['desk-1.jsonl']), 'shop-1'), path.join(projectLink, 'shop-2'), 'junction')
  const chatsLink = path.join(tempDir('drive'), 'Claude chats')
  fs.symlinkSync(withCopies(['desk-1.jsonl']), chatsLink, 'junction')
  const another = { projects: 1, computers: ['desk-1'] }
  const cases = [
    { name: 'another computer\'s copy', chats: withCopies(['desk-1.jsonl', 'me-2.jsonl']), want: another },
    { name: 'only this computer\'s copy', chats: withCopies(['me-2.jsonl']), want: null },
    { name: 'no chats folder', chats: path.join(tempDir('drive'), 'Claude chats'), want: null },
    { name: 'a project folder that is a link', chats: projectLink, want: null },
    { name: 'a chats folder that is a link', chats: chatsLink, want: null },
    { name: 'another computer\'s copy a move kept aside', chats: withCopies(['desk-1-moved-1.jsonl']), want: another },
    { name: 'this computer\'s own copy a move kept aside', chats: withCopies(['me-2-moved-1.jsonl']), want: null },
  ]
  for (const row of cases) {
    const found = othersChats(row.chats, 'me-2')
    assert.deepStrictEqual(found && { projects: found.projects, computers: found.computers }, row.want, row.name)
  }
})

test('a sync folder that cannot be listed, such as an offline cloud folder, reads as holding nothing', () => {
  const { othersChats } = require(path.join(SCRIPTS, 'commands.cjs'))
  const unreadable = withCopies(['desk-1.jsonl'])
  const realReaddir = fs.readdirSync
  fs.readdirSync = (folder, ...rest) => {
    const isStore = path.resolve(String(folder)) === path.resolve(unreadable)
    if (isStore) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    return realReaddir(folder, ...rest)
  }
  try {
    assert.strictEqual(othersChats(unreadable, 'me-2'), null)
  } finally {
    fs.readdirSync = realReaddir
  }
})

// Run: node --test test-helper/sync.spec.cjs
'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const SCRIPTS = path.join(__dirname, '..', 'scripts')
const SYNC = path.join(SCRIPTS, 'sync.cjs')
const { neutralize, expand } = require(path.join(SCRIPTS, 'paths.cjs'))

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `chat-sync-${name}-`))
}

// One computer: its own config folder, home folder and copy of the project.
function computer(name, store) {
  const home = tempDir(`${name}-home`)
  const root = path.join(home, 'work', 'shop')
  fs.mkdirSync(path.join(root, '.bindwright'), { recursive: true })
  fs.writeFileSync(path.join(root, '.bindwright', 'project.json'), JSON.stringify({ project: { name: 'shop' } }))
  const config = path.join(home, '.claude')
  const chatDir = path.join(config, 'projects', name)
  fs.mkdirSync(chatDir, { recursive: true })
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home }
  const sync = (...args) => JSON.parse(execFileSync(process.execPath, [SYNC, ...args], { env, encoding: 'utf8' }))
  if (store) sync('move', 'folder', store)
  return { home, root, chatDir, sync }
}

// A chat file whose every line names the project folder, as Claude Code writes it.
function writeChat(pc, id, texts) {
  const lines = texts.map(text => JSON.stringify({ cwd: pc.root, message: { content: `${text} in ${pc.root}` } }))
  fs.writeFileSync(path.join(pc.chatDir, `${id}.jsonl`), lines.map(line => `${line}\n`).join(''))
}

function readChat(pc, id) {
  return fs.readFileSync(path.join(pc.chatDir, `${id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

test('a Windows chat moved to a computer without drive letters gets its paths in every form', () => {
  const line = JSON.stringify({
    cwd: 'C:\\Users\\al\\work\\app', note: 'C:/Users/al/work/app/a.js', home: 'C:\\Users\\al',
  })
  const nested = JSON.stringify({ inner: line })
  const out = neutralize('C:\\Users\\al\\work\\app', 'C:\\Users\\al')
  const back = expand('/home/sam/dev/app', '/home/sam')
  assert.deepStrictEqual(JSON.parse(back(out(line))),
    { cwd: '/home/sam/dev/app', note: '/home/sam/dev/app/a.js', home: '/home/sam' })
  assert.strictEqual(JSON.parse(JSON.parse(back(out(nested))).inner).cwd, '/home/sam/dev/app')
})

test('a folder name is only swapped where it ends, never inside a longer name', () => {
  const out = neutralize('C:\\work\\app', 'C:\\Users\\al')
  const line = JSON.stringify({ a: 'C:\\Users\\alex\\x', b: 'C:\\work\\apples' })
  assert.strictEqual(out(line), line)
})

test('a chat copied out on one computer resumes on another with that computer\'s project folder', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['first', 'second'])
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { copied: 's1' })
  const brought = b.sync('in', b.chatDir, b.root, 'other')
  assert.deepStrictEqual(brought.imported, ['s1'])
  assert.deepStrictEqual(readChat(b, 's1').map(r => r.cwd), [b.root, b.root])
  assert.strictEqual(readChat(b, 's1')[1].message.content, `second in ${b.root}`)
})

test('the newer copy wins in each direction, and copies that both changed are both kept', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  b.sync('in', b.chatDir, b.root, 'other')
  writeChat(a, 's1', ['one', 'two'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'], 'store ahead: brought in')
  writeChat(b, 's1', ['one', 'two', 'three from b'])
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, [], 'local ahead: kept')
  writeChat(a, 's1', ['one', 'two', 'three from a'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').conflicts, ['s1'])
  assert.strictEqual(readChat(b, 's1')[2].message.content, `three from b in ${b.root}`, 'local copy untouched')
})

test('the chat open in this session is never written, only reported as behind', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(b, 's1', ['one'])
  writeChat(a, 's1', ['one', 'two'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const brought = b.sync('in', b.chatDir, b.root, 's1')
  assert.deepStrictEqual([brought.imported, brought.behind], [[], ['s1']])
  assert.strictEqual(readChat(b, 's1').length, 1)
})

test('a chat another computer is writing to is not copied over', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  writeChat(b, 's1', ['one', 'other'])
  const answer = b.sync('out', path.join(b.chatDir, 's1.jsonl'), b.root)
  assert.strictEqual(answer.held, 's1')
  assert.ok(b.sync('in', b.chatDir, b.root, 'x').openElsewhere.some(open => open.id === 's1'))
})

test('moving to another folder copies every chat, switches, and keeps the old copy', () => {
  const first = tempDir('first')
  const second = tempDir('second')
  const a = computer('a', first)
  writeChat(a, 's1', ['one'])
  writeChat(a, 's2', ['two'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  a.sync('out', path.join(a.chatDir, 's2.jsonl'), a.root)
  const moved = a.sync('move', 'folder', second)
  assert.strictEqual(moved.moved, 2)
  assert.deepStrictEqual(fs.readdirSync(path.join(second, 'shop')).filter(n => n.endsWith('.jsonl')).sort(),
    ['s1.jsonl', 's2.jsonl'])
  assert.ok(fs.existsSync(path.join(first, 'shop', 's1.jsonl')), 'old copy kept')
  assert.strictEqual(a.sync('status', a.root).place.path, path.resolve(second))
})

test('a project keeps one name across computers from its git remote, in https and ssh form alike', () => {
  const keys = ['https://github.com/acme/shop.git', 'git@github.com:acme/shop.git'].map(remote => {
    const pc = computer('k')
    execFileSync('git', ['init', '-q', pc.root])
    execFileSync('git', ['-C', pc.root, 'remote', 'add', 'origin', remote])
    return pc.sync('status', pc.root).project
  })
  assert.deepStrictEqual(keys, ['github.com-acme-shop', 'github.com-acme-shop'])
})

test('with no place chosen, nothing is copied', () => {
  const a = computer('a')
  writeChat(a, 's1', ['one'])
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { skipped: 'off' })
})

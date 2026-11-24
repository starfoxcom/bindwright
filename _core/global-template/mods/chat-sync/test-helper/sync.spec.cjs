// Run: node --test test-helper/sync.spec.cjs
'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { promisify } = require('util')
const { execFile, execFileSync, spawnSync } = require('child_process')

const execFileAsync = promisify(execFile)

const SCRIPTS = path.join(__dirname, '..', 'scripts')
const SYNC = path.join(SCRIPTS, 'sync.cjs')
const { neutralize, expand } = require(path.join(SCRIPTS, 'paths.cjs'))

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `chat-sync-${name}-`))
}

function gitConfig(text) {
  const file = path.join(tempDir('gitconfig'), 'config')
  fs.writeFileSync(file, text)
  return file
}

// Git that reads none of this computer's own settings or hooks.
// It changes line ends on checkout, as git on Windows does by default.
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: gitConfig('[core]\n\tautocrlf = true\n'),
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

// One computer: its own config folder, home folder and copy of the project.
// `paths` gives another computer's project and home folders as text only, such
// as /home/sam on Windows: the project is then named after its folder.
function computer(name, store, paths = {}) {
  const own = tempDir(`${name}-home`)
  const home = paths.home || own
  const root = paths.root || path.join(own, 'work', 'shop')
  if (!paths.root) {
    fs.mkdirSync(path.join(root, '.bindwright'), { recursive: true })
    fs.writeFileSync(path.join(root, '.bindwright', 'project.json'), JSON.stringify({ project: { name: 'shop' } }))
  }
  const config = path.join(own, '.claude')
  const chatDir = path.join(config, 'projects', name)
  fs.mkdirSync(chatDir, { recursive: true })
  const dataDir = path.join(config, 'mods-data', 'chat-sync')
  if (paths.id) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'machine.json'), JSON.stringify({ id: paths.id }))
  }
  const env = { ...process.env, ...GIT_ENV, ...paths.env, CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home }
  const sync = (...args) => JSON.parse(execFileSync(process.execPath, [SYNC, ...args], { env, encoding: 'utf8' }))
  if (store) sync('move', 'folder', store)
  return { home, root, chatDir, sync, dataDir, env }
}

// A computer whose chats sync through a clone of the bare repo `origin`, set up
// as `move git` leaves it, with the repo already confirmed private.
function gitComputer(name, origin, env = {}) {
  const pc = computer(name, null, { env })
  const repo = 'me/chats'
  fs.mkdirSync(pc.dataDir, { recursive: true })
  fs.writeFileSync(path.join(pc.dataDir, 'place.json'), JSON.stringify({ kind: 'git', repo }))
  fs.writeFileSync(path.join(pc.dataDir, 'visibility.json'), JSON.stringify({ repo, at: Date.now() }))
  execFileSync('git', ['clone', '-q', origin, path.join(pc.dataDir, 'repo')], { env: { ...process.env, ...GIT_ENV } })
  return pc
}

// Runs `move git` inside this process as computer `pc`, with gh answering that
// the repo is private and lives at the bare repo `origin`; `afterClone` gets the
// new clone's folder once it is fetched, and `sshUsed` the ssh command each
// fetch or clone ran with.
function moveToRepo(pc, origin, afterClone = () => {}, sshUsed = []) {
  const childProcess = require('child_process')
  const realSpawn = childProcess.spawnSync
  const answer = stdout => ({ status: 0, stdout: `${stdout}\n`, stderr: '' })
  childProcess.spawnSync = (command, args, options) => {
    if (command === 'gh') return answer(args[0] === 'config' ? '' : args.includes('visibility') ? 'PRIVATE' : origin)
    const isFetch = command === 'git' && (args.includes('fetch') || args.includes('clone'))
    if (isFetch) sshUsed.push(options.env.GIT_SSH_COMMAND)
    const run = realSpawn(command, args, options)
    if (isFetch) afterClone(args[args.indexOf('-C') + 1])
    return run
  }
  try {
    return inProcess(pc, () => require(path.join(SCRIPTS, 'move.cjs')).move(['git', 'me/chats']))
  } finally {
    childProcess.spawnSync = realSpawn
  }
}

// Runs `work` inside this process as computer `pc`, with the helper's scripts
// loaded fresh for it. A helper counts its time from its process's start, which
// here is the test run's, so the limits are lifted.
function inProcess(pc, work) {
  const savedEnv = { ...process.env }
  const scripts = ['sync.cjs', 'commands.cjs', 'move.cjs', 'paths.cjs', 'places.cjs', 'lock.cjs']
    .map(name => require.resolve(path.join(SCRIPTS, name)))
  const reload = () => scripts.forEach(file => delete require.cache[file])
  Object.assign(process.env, { CHAT_SYNC_RUN_BUDGET_MS: '1e12', CHAT_SYNC_COPY_LIMIT_MS: '1e12' }, pc.env)
  reload()
  try {
    return work()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
    reload()
  }
}

// Runs the helper as computer `pc` while every file whose path holds the name
// `busy` (a unique folder or file name) refuses to open, as a file a sync app
// holds open does on Windows.
function syncWithBusyFiles(pc, busy, ...args) {
  const realOpen = fs.openSync
  fs.openSync = (file, ...rest) => {
    if (String(file).includes(busy)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY' })
    }
    return realOpen(file, ...rest)
  }
  try {
    return inProcess(pc, () => require(path.join(SCRIPTS, 'commands.cjs')).run(args))
  } finally {
    fs.openSync = realOpen
  }
}

// The files committed on the bare repo's main branch.
function committed(origin) {
  return execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
}

function bareRepo() {
  const origin = tempDir('origin')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: { ...process.env, ...GIT_ENV } })
  return origin
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

test('only this computer\'s own folders are swapped, never a longer path or name that holds them', () => {
  const windows = neutralize('C:\\work\\app', 'C:\\Users\\al')
  const posix = neutralize('/srv/app', '/home/sam')
  const network = neutralize('\\\\nas\\projects\\foo', 'C:\\Users\\al')
  const mac = neutralize('/srv/app', '/Users/al')
  const short = neutralize('/srv/app', '/home/jos')
  const kept = [
    ['a longer folder name', windows, 'C:\\Users\\alex\\x'],
    ['a longer project name', windows, 'C:\\work\\apples'],
    ['inside a web address', posix, 'https://example.com/home/sam/x'],
    ['a network path in a web address', network, 'https://nas/projects/foo/x'],
    ['a home after a drive letter', mac, 'C:/Users/al/x'],
    ['a longer name in another alphabet', short, '/home/josé/x'],
    ['a name going on with an accent mark', neutralize('/srv/app', '/Users/jose'), '/Users/josé/x'],
    ['a name going on with a vowel sign', neutralize('/srv/app', '/home/राम'), '/home/रामा/x'],
    ['inside a longer path', posix, '/mnt/backup/home/sam/x'],
    ['a name with a suffix', posix, '/home/sam.bak/x'],
    ['the project name in a relative path', posix, 'src/srv/app/main.ts'],
  ]
  for (const [label, out, text] of kept) {
    const line = JSON.stringify({ text })
    assert.strictEqual(out(line), line, label)
  }
  const swapped = [
    ['a quoted path', '"/home/sam/x"', '"__CHATSYNC_HOME_F__/x"'],
    ['a path ending a sentence', '"in /home/sam."', '"in __CHATSYNC_HOME_F__."'],
    ['a path after an escaped newline', '"a\\n/home/sam/x"', '"a\\n__CHATSYNC_HOME_F__/x"'],
    ['a path in a list after a colon', '"PATH=/usr/bin:/home/sam/bin"', '"PATH=/usr/bin:__CHATSYNC_HOME_F__/bin"'],
  ]
  for (const [label, text, want] of swapped) assert.strictEqual(posix(text), want, label)
  const rootHome = neutralize('/srv/app', '/')
  assert.strictEqual(rootHome('"/etc/hosts"'), '"/etc/hosts"', 'a home of / is never swapped')
  const homeInside = neutralize('/home', '/home/sam')
  assert.strictEqual(homeInside('"/home/sam/x"'), '"__CHATSYNC_HOME_F__/x"', 'the deeper folder wins')
})

test('a folder or link planted at this computer\'s temporary copy name never stops or redirects a copy', t => {
  const store = tempDir('store')
  const outside = path.join(tempDir('outside'), 'victim.txt')
  fs.writeFileSync(outside, 'keep me')
  const a = computer('a', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const folder = path.join(store, 'shop', 's1')
  const own = fs.readdirSync(folder)[0]
  fs.mkdirSync(path.join(folder, `.${own}.folder.tmp`))
  writeChat(a, 's1', ['one', 'more'])
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { copied: 's1' })
  try {
    fs.symlinkSync(outside, path.join(folder, `.${own}.planted.tmp`))
  } catch {
    t.skip('this computer cannot make file links')
    return
  }
  writeChat(a, 's1', ['one', 'two'])
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { copied: 's1' })
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep me')
  assert.ok(!fs.existsSync(path.join(folder, `.${own}.planted.tmp`)), 'the link is removed')
})

test('a network path is swapped like a drive path', () => {
  const out = neutralize('\\\\server\\share\\app', 'C:\\Users\\al')
  const line = JSON.stringify({ cwd: '\\\\server\\share\\app\\x' })
  assert.strictEqual(out(line), '{"cwd":"__CHATSYNC_PROJECT_E1__\\\\x"}')
})

test('a Windows chat continued on Linux comes back to Windows whole, and both sides then read the same', () => {
  const store = tempDir('store')
  const win = computer('w', store, { root: 'C:\\Users\\al\\work\\shop', home: 'C:\\Users\\al' })
  const linux = computer('l', store, { root: '/home/sam/work/shop', home: '/home/sam' })
  writeChat(win, 's1', ['one', 'two'])
  win.sync('out', path.join(win.chatDir, 's1.jsonl'), win.root)
  assert.deepStrictEqual(linux.sync('in', linux.chatDir, linux.root, 'other').imported, ['s1'])
  writeChat(linux, 's1', ['one', 'two', 'three'])
  assert.deepStrictEqual(linux.sync('out', path.join(linux.chatDir, 's1.jsonl'), linux.root), { copied: 's1' })
  const back = win.sync('in', win.chatDir, win.root, 'other')
  assert.deepStrictEqual([back.imported, back.conflicts], [['s1'], []])
  assert.deepStrictEqual(readChat(win, 's1').map(r => r.cwd.replace(/\//g, '\\')), [win.root, win.root, win.root])
  for (const pc of [win, linux]) {
    const again = pc.sync('in', pc.chatDir, pc.root, 'other')
    assert.deepStrictEqual([again.imported, again.conflicts], [[], []], `${pc.root} reads the same`)
  }
})

test('a chat that quotes the placeholders keeps them as text and reads the same on both computers', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  const quoted = 'x__CHATSYNC_HOME_F__ and conflicts/__CHATSYNC_PROJECT_F__s and __CHATSYNC__CHATSYNC_PROJECT_F__'
  writeChat(a, 's1', [quoted])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  b.sync('in', b.chatDir, b.root, 'other')
  assert.strictEqual(readChat(b, 's1')[0].message.content, `${quoted} in ${b.root}`)
  writeChat(b, 's1', [quoted, 'more'])
  b.sync('out', path.join(b.chatDir, 's1.jsonl'), b.root)
  const back = a.sync('in', a.chatDir, a.root, 'other')
  assert.deepStrictEqual([back.imported, back.conflicts], [['s1'], []])
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

test('two computers writing one chat each keep their own copy, and neither is written over', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  writeChat(b, 's1', ['one', 'from b'])
  assert.deepStrictEqual(b.sync('out', path.join(b.chatDir, 's1.jsonl'), b.root), { copied: 's1' })
  writeChat(a, 's1', ['one', 'from a'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.strictEqual(fs.readdirSync(path.join(store, 'shop', 's1')).length, 2)
  assert.deepStrictEqual(a.sync('in', a.chatDir, a.root, 'other').conflicts, ['s1'])
  assert.strictEqual(readChat(a, 's1')[1].message.content, `from a in ${a.root}`)
})

test('a chat that changed here but never went out is sent at the next session start', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  assert.deepStrictEqual(a.sync('in', a.chatDir, a.root, 'other').sent, ['s1'])
  assert.deepStrictEqual(a.sync('in', a.chatDir, a.root, 'other').sent, [], 'sent once')
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
})

test('a copy that went missing from the sync place is sent again, though the chat did not change', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const folder = path.join(store, 'shop', 's1')
  for (const name of fs.readdirSync(folder)) fs.rmSync(path.join(folder, name))
  assert.deepStrictEqual(a.sync('in', a.chatDir, a.root, 'other').sent, ['s1'])
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
})

test('a chat deleted on this computer stays deleted until another computer continues it', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  b.sync('in', b.chatDir, b.root, 'other')
  fs.rmSync(path.join(b.chatDir, 's1.jsonl'))
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, [])
  assert.ok(!fs.existsSync(path.join(b.chatDir, 's1.jsonl')))
  writeChat(a, 's1', ['one', 'two'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
  assert.strictEqual(readChat(b, 's1')[1].message.content, `two in ${b.root}`)
})

test('a chat deleted here whose copy went missing from the sync place comes back', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  b.sync('in', b.chatDir, b.root, 'other')
  b.sync('in', b.chatDir, b.root, 'other')
  const folder = path.join(store, 'shop', 's1')
  assert.strictEqual(fs.readdirSync(folder).length, 2, 'both computers sent a copy')
  fs.rmSync(path.join(b.chatDir, 's1.jsonl'))
  const own = JSON.parse(fs.readFileSync(path.join(b.dataDir, 'machine.json'), 'utf8')).id
  fs.rmSync(path.join(folder, `${own}.jsonl`))
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
})

test('a chat naming the other computer\'s home as text goes back and forth without splitting', () => {
  const store = tempDir('store')
  const laptop = computer('l', store, { root: '/Users/sam/work/shop', home: '/Users/sam' })
  const desktop = computer('d', store, { root: '/home/sam/work/shop', home: '/home/sam' })
  writeChat(laptop, 's1', ['ssh desktop cat /home/sam/notes.txt'])
  laptop.sync('out', path.join(laptop.chatDir, 's1.jsonl'), laptop.root)
  desktop.sync('in', desktop.chatDir, desktop.root, 'other')
  writeChat(desktop, 's1', ['ssh desktop cat /home/sam/notes.txt', 'more'])
  desktop.sync('out', path.join(desktop.chatDir, 's1.jsonl'), desktop.root)
  const back = laptop.sync('in', laptop.chatDir, laptop.root, 'other')
  assert.deepStrictEqual([back.imported, back.conflicts], [['s1'], []])
})

test('a project folder in the sync place that is a link is never written or read through', () => {
  const store = tempDir('store')
  const outside = tempDir('outside')
  const a = computer('a', store)
  fs.symlinkSync(outside, path.join(store, 'shop'), 'junction')
  writeChat(a, 's1', ['one'])
  assert.match(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).error, /is a link/)
  assert.deepStrictEqual(fs.readdirSync(outside), [])
  fs.mkdirSync(path.join(outside, 's2'))
  fs.writeFileSync(path.join(outside, 's2', 'other.jsonl'), '{"planted":true}\n')
  const b = computer('b', store)
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, [])
  assert.ok(!fs.existsSync(path.join(b.chatDir, 's2.jsonl')))
})

test('a computer whose host name holds a dot is read by the others', () => {
  const store = tempDir('store')
  const mac = computer('m', store, { id: 'Sams-MacBook-Pro.local-ab12cd' })
  const b = computer('b', store)
  writeChat(mac, 's1', ['one'])
  mac.sync('out', path.join(mac.chatDir, 's1.jsonl'), mac.root)
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
})

test('the first chat into a project this computer never opened makes its chat folder', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  fs.rmSync(b.chatDir, { recursive: true })
  const brought = b.sync('in', b.chatDir, b.root, 'other')
  assert.deepStrictEqual([brought.imported, brought.error], [['s1'], undefined])
})

test('a temporary copy left by a stopped helper is cleared at the next copy out', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const folder = path.join(store, 'shop', 's1')
  const left = path.join(folder, `.${fs.readdirSync(folder)[0]}.99999.tmp`)
  fs.writeFileSync(left, 'half')
  fs.utimesSync(left, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  writeChat(a, 's1', ['one', 'two'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.ok(!fs.existsSync(left))
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
  assert.deepStrictEqual(fs.readdirSync(path.join(second, 'shop')).sort(), ['s1', 's2'])
  assert.ok(fs.existsSync(path.join(first, 'shop', 's1')), 'old copy kept')
  assert.strictEqual(a.sync('status', a.root).place.path, path.resolve(second))
  assert.deepStrictEqual(a.sync('in', a.chatDir, a.root, 'other').sent, [], 'nothing to send again')
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

test('through a git repo that changes line ends, a chat goes back and forth between two computers', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin)
  const b = gitComputer('b', origin)
  writeChat(a, 's1', ['one'])
  assert.strictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).pushed, true, 'first push')
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
  writeChat(b, 's1', ['one', 'two from b'])
  const fromB = b.sync('out', path.join(b.chatDir, 's1.jsonl'), b.root)
  assert.deepStrictEqual([fromB.copied, fromB.pushed], ['s1', true])
  const atA = a.sync('in', a.chatDir, a.root, 'other')
  assert.deepStrictEqual([atA.imported, atA.conflicts, atA.error], [['s1'], [], undefined])
  writeChat(a, 's1', ['one', 'two from b', 'three from a'])
  assert.strictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).pushed, true)
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
  assert.strictEqual(readChat(b, 's1').length, 3)
})

test('a copy left half written in the clone is written again whole', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin)
  const b = gitComputer('b', origin)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const folder = path.join(a.dataDir, 'repo', 'shop', 's1')
  fs.appendFileSync(path.join(folder, fs.readdirSync(folder)[0]), '{"cut":')
  b.sync('in', b.chatDir, b.root, 'other')
  writeChat(a, 's1', ['one', 'two'])
  assert.strictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).pushed, true)
  const tree = execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })
  for (const file of tree.trim().split('\n')) {
    const text = execFileSync('git', ['--git-dir', origin, 'show', `main:${file}`], { encoding: 'utf8' })
    assert.ok(!text.includes('cut'), `${file} holds whole lines only`)
  }
})

test('a chat cut off mid-line here takes the newer copy\'s lines whole', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  b.sync('in', b.chatDir, b.root, 'other')
  fs.appendFileSync(path.join(b.chatDir, 's1.jsonl'), '{"cut":')
  writeChat(a, 's1', ['one', 'two'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
  assert.deepStrictEqual(readChat(b, 's1').map(r => r.message.content), [`one in ${b.root}`, `two in ${b.root}`])
})

test('a chat repo that cannot be confirmed private at session start says so and sends nothing', () => {
  const a = gitComputer('a', bareRepo(), { GH_HOST: 'chat-sync.invalid' })
  fs.writeFileSync(path.join(a.dataDir, 'visibility.json'), JSON.stringify({ repo: 'me/chats', at: 0 }))
  writeChat(a, 's1', ['one'])
  const answer = a.sync('in', a.chatDir, a.root, 'other')
  assert.match(answer.error || '', /private/)
  assert.deepStrictEqual(answer.sent, [])
})

test('a chat repo that never answers stops the run within its limit, with an answer', async () => {
  const server = http.createServer(() => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const a = gitComputer('a', bareRepo(), { CHAT_SYNC_COPY_LIMIT_MS: '4000' })
    const url = `http://127.0.0.1:${server.address().port}/chats.git`
    execFileSync('git', ['-C', path.join(a.dataDir, 'repo'), 'remote', 'set-url', 'origin', url])
    const started = Date.now()
    const run = await execFileAsync(process.execPath, [SYNC, 'in', a.chatDir, a.root, 'other'],
      { env: a.env, timeout: 40_000 })
    assert.match(JSON.parse(run.stdout).error || '', /time/)
    assert.ok(Date.now() - started < 20_000, 'the run kept to its limit')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

// A password prompt program, as an editor's terminal sets one, that would keep
// git waiting; it leaves a mark when git starts it.
function waitingAskpass() {
  const folder = tempDir('askpass')
  const mark = path.join(folder, 'asked').replace(/\\/g, '/')
  const program = path.join(folder, 'askpass.sh')
  fs.writeFileSync(program, `#!/bin/sh\necho asked > "${mark}"\nsleep 120\n`, { mode: 0o755 })
  return { program: program.replace(/\\/g, '/'), mark }
}

test('a chat repo that asks for a password fails at once instead of waiting on a prompt', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="chats"' })
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const plain = () => ({})
  const fromEnv = askpass => ({ GIT_ASKPASS: askpass.program, SSH_ASKPASS: askpass.program })
  const fromConfig = askpass => ({ GIT_CONFIG_GLOBAL: gitConfig(`[core]\n\taskPass = ${askpass.program}\n`) })
  try {
    for (const [name, env] of [['no prompt program', plain], ['GIT_ASKPASS', fromEnv], ['core.askPass', fromConfig]]) {
      const askpass = waitingAskpass()
      const a = gitComputer('a', bareRepo(), env(askpass))
      const url = `http://127.0.0.1:${server.address().port}/chats.git`
      execFileSync('git', ['-C', path.join(a.dataDir, 'repo'), 'remote', 'set-url', 'origin', url])
      writeChat(a, 's1', ['one'])
      const started = Date.now()
      const run = await execFileAsync(process.execPath, [SYNC, 'in', a.chatDir, a.root, 'other'],
        { env: a.env, timeout: 50_000 })
      assert.match(JSON.parse(run.stdout).pushError || '', /terminal prompts disabled|password from user/, name)
      assert.ok(Date.now() - started < 20_000, `${name}: no git call waited out its time limit`)
      assert.ok(!fs.existsSync(askpass.mark), `${name}: no prompt program was started`)
    }
  } finally {
    server.close()
  }
})

test('a sync folder named from the home folder lands there, and a relative one is refused', () => {
  const a = computer('a')
  assert.match(a.sync('move', 'folder', 'Claude chats').error, /full path/)
  assert.strictEqual(a.sync('move', 'folder', '~/Claude chats').to, path.join(a.home, 'Claude chats'))
})

test('a folder planted at this computer\'s own copy is cleared, and one failing chat never stops the rest', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const folder = path.join(store, 'shop', 's1')
  const own = path.join(folder, fs.readdirSync(folder)[0])
  fs.rmSync(own)
  fs.mkdirSync(own)
  writeChat(a, 's1', ['one', 'two'])
  writeChat(a, 's2', ['other'])
  assert.deepStrictEqual(a.sync('in', a.chatDir, a.root, 'other').sent.sort(), ['s1', 's2'])
  assert.ok(fs.lstatSync(own).isFile())
})

test('an import a stopped helper left half done is cleared at the next session start', () => {
  const a = computer('a', tempDir('store'))
  const left = path.join(a.chatDir, 's1.jsonl.chat-sync.99999.in')
  fs.writeFileSync(left, 'half')
  fs.utimesSync(left, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  a.sync('in', a.chatDir, a.root, 'other')
  assert.ok(!fs.existsSync(left))
})

test('a session that ends before its first message has no chat to copy, and says nothing', () => {
  const a = computer('a', tempDir('store'))
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 'unsent.jsonl'), a.root), { skipped: 'no chat yet' })
})

test('state that is there but unreadable stops the helper and is never written over', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  b.sync('in', b.chatDir, b.root, 'other')
  fs.rmSync(path.join(b.chatDir, 's1.jsonl'))
  for (const name of ['seen.json', 'machine.json']) {
    const file = path.join(b.dataDir, name)
    const kept = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, '{"half')
    assert.match(b.sync('in', b.chatDir, b.root, 'other').error || '', /not valid JSON/, name)
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"half', `${name} is left as it is`)
    assert.ok(!fs.existsSync(path.join(b.chatDir, 's1.jsonl')), `the deleted chat stays gone with ${name} unreadable`)
    fs.writeFileSync(file, kept)
  }
})

test('a repo name that starts with a dash is refused before gh sees it', () => {
  const a = computer('a')
  for (const repo of ['-b/x', 'me/-x']) assert.match(a.sync('move', 'git', repo).error, /owner\/repo/, repo)
})

test('with no place chosen, nothing is copied and asking the status writes nothing', () => {
  const a = computer('a')
  writeChat(a, 's1', ['one'])
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { skipped: 'off' })
  assert.strictEqual(a.sync('status', a.root).place.kind, 'off')
  assert.ok(!fs.existsSync(a.dataDir), 'nothing is written before setup is told yes')
})

test('the user\'s own commit signing and hooks never run on the chat repo\'s commits', () => {
  const hooks = tempDir('hooks')
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const config = gitConfig(`[core]\n\tautocrlf = true\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n`
    + '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = chat-sync-no-such-signer\n')
  const a = gitComputer('a', bareRepo(), { GIT_CONFIG_GLOBAL: config })
  writeChat(a, 's1', ['one'])
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { copied: 's1', pushed: true })
})

test('a lock a stopped git left in the clone is cleared, and a recent one shows git\'s own words', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin)
  const lock = path.join(a.dataDir, 'repo', '.git', 'index.lock')
  writeChat(a, 's1', ['one'])
  fs.writeFileSync(lock, '')
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(lock, tenMinutesAgo, tenMinutesAgo)
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { copied: 's1', pushed: true })
  assert.ok(committed(origin).some(file => file.startsWith('shop/s1/')), 'the chat reached the repo')

  writeChat(a, 's2', ['two'])
  fs.writeFileSync(lock, '')
  const answer = a.sync('out', path.join(a.chatDir, 's2.jsonl'), a.root)
  assert.match(answer.pushError || '', /index\.lock/, 'git\'s own words reach the notice')
})

test('a run waits for another run on this computer, and takes over from one that was stopped', async () => {
  const a = computer('a', tempDir('folder'))
  const lock = path.join(a.dataDir, 'run.lock')
  writeChat(a, 's1', ['one'])
  fs.writeFileSync(lock, String(process.pid))
  const running = execFileAsync(process.execPath, [SYNC, 'out', path.join(a.chatDir, 's1.jsonl'), a.root],
    { env: a.env })
  let finishedAt = 0
  running.then(() => { finishedAt = Date.now() }, () => {})
  await new Promise(resolve => setTimeout(resolve, 1_000))
  const releasedAt = Date.now()
  fs.rmSync(lock)
  const run = await running
  assert.ok(finishedAt >= releasedAt, 'the run finished only after the other one let go')
  assert.deepStrictEqual(JSON.parse(run.stdout), { copied: 's1' })

  const stopped = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'],
    { encoding: 'utf8' })
  fs.writeFileSync(lock, stopped)
  writeChat(a, 's1', ['one', 'two'])
  assert.deepStrictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root), { copied: 's1' })
  assert.ok(!fs.existsSync(lock), 'the lock is let go after the run')
})

test('a move into a repo that does not take the chats keeps them syncing where they did', () => {
  const first = tempDir('first')
  const a = computer('a', first)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const origin = bareRepo()
  const answer = moveToRepo(a, origin, folder => {
    execFileSync('git', ['-C', folder, 'remote', 'set-url', '--push', 'origin', path.join(first, 'no-repo')])
  })
  assert.match(answer.error || '', /still sync where they did/)
  assert.strictEqual(a.sync('status', a.root).place.path, path.resolve(first))
})

test('the first clone uses the ssh command a conditional include keeps for the repo', () => {
  const origin = bareRepo().replace(/\\/g, '/')
  const included = gitConfig('[core]\n\tsshCommand = ssh -i work-key\n').replace(/\\/g, '/')
  const config = gitConfig(`[includeIf "hasconfig:remote.*.url:**/${path.basename(origin)}"]\n\tpath = ${included}\n`)
  const a = computer('a', null, { env: { GIT_CONFIG_GLOBAL: config } })
  const sshUsed = []
  const answer = moveToRepo(a, origin, undefined, sshUsed)
  assert.ok(!answer.error, answer.error)
  assert.deepStrictEqual(sshUsed, [undefined], 'git picks the included command itself')
})

test('a sync folder that went missing is reported and never made again here', () => {
  const folder = tempDir('drive')
  const a = computer('a', folder)
  writeChat(a, 's1', ['one'])
  fs.rmSync(folder, { recursive: true })
  assert.match(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).error || '', /sync folder .* is missing/)
  assert.ok(!fs.existsSync(folder), 'the folder is not made again')
  assert.match(a.sync('move', 'folder', tempDir('target')).error || '', /not moved, since the sync folder/)
  assert.strictEqual(a.sync('status', a.root).place.path, path.resolve(folder), 'the place did not switch')
})

test('a newer copy that cannot be read yet is brought in once it can be', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  b.sync('in', b.chatDir, b.root, 'other')
  writeChat(a, 's1', ['one', 'two'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const busy = syncWithBusyFiles(b, path.basename(store), 'in', b.chatDir, b.root, 'other')
  assert.match(busy.error || '', /could not read/)
  assert.deepStrictEqual(busy.imported, [])
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, ['s1'])
})

test('a run clears the private copies a stopped run left behind', () => {
  const a = computer('a', tempDir('store'))
  const left = path.join(a.dataDir, 'work', 'run-stopped')
  fs.mkdirSync(left, { recursive: true })
  fs.writeFileSync(path.join(left, 'mine'), 'a whole chat\n')
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.ok(!fs.existsSync(left), 'the stopped run\'s copies are gone')
})

test('a move out of a folder that holds other things copies only the chats', () => {
  const first = tempDir('first')
  const a = computer('a', first)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  fs.mkdirSync(path.join(first, 'photos', '2024'), { recursive: true })
  const target = tempDir('target')
  assert.strictEqual(a.sync('move', 'folder', target).moved, 1)
  assert.deepStrictEqual(fs.readdirSync(target), ['shop'])
})

test('this computer\'s own copy that cannot be read never brings a deleted chat back', () => {
  const store = tempDir('store')
  const a = computer('a', store)
  const b = computer('b', store)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const folder = path.join(store, 'shop', 's1')
  const [fromA] = fs.readdirSync(folder)
  b.sync('in', b.chatDir, b.root, 'other')
  const ownOfB = fs.readdirSync(folder).find(name => name !== fromA)
  fs.rmSync(path.join(b.chatDir, 's1.jsonl'))
  fs.utimesSync(path.join(folder, fromA), new Date(), new Date(Date.now() + 5_000))
  const busy = syncWithBusyFiles(b, ownOfB, 'in', b.chatDir, b.root, 'other')
  assert.match(busy.error || '', /could not read/)
  assert.deepStrictEqual(busy.imported, [])
  assert.deepStrictEqual(b.sync('in', b.chatDir, b.root, 'other').imported, [], 'nobody continued it')
})

test('plain ssh runs in batch mode, an ssh the user set runs as set, and GitHub signs in through gh', () => {
  const clone = tempDir('clone')
  execFileSync('git', ['init', '-q', clone], { env: { ...process.env, ...GIT_ENV } })
  execFileSync('git', ['-C', clone, 'config', 'core.sshCommand', 'ssh -i work-key'])
  const rows = [
    ['nothing set', {}, tempDir('plain'), 'ssh -o BatchMode=yes'],
    ['GIT_SSH_COMMAND', { GIT_SSH_COMMAND: 'ssh -i key' }, tempDir('plain'), 'ssh -i key'],
    ['GIT_SSH', { GIT_SSH: 'plink' }, tempDir('plain'), undefined],
    ['core.sshCommand set only in the clone', {}, clone, undefined],
  ]
  for (const [name, env, folder, expected] of rows) {
    const command = inProcess({ env: { ...GIT_ENV, ...env } }, () => {
      for (const key of ['GIT_SSH_COMMAND', 'GIT_SSH']) if (!(key in env)) delete process.env[key]
      return require(SYNC).quietEnv(folder).GIT_SSH_COMMAND
    })
    assert.strictEqual(command, expected, name)
  }
  const helper = execFileSync('git',
    [...require(SYNC).gitSettings(), 'config', '--get-urlmatch', 'credential.helper', 'https://github.com/me/chats'],
    { env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' })
  assert.strictEqual(helper.trim(), '!gh auth git-credential')
})

test('a pull that a stopped run left half done is undone, and its commits still go up', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin)
  const clone = path.join(a.dataDir, 'repo')
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  execFileSync('git', ['-C', clone, 'remote', 'set-url', '--push', 'origin', path.join(a.home, 'gone')])
  writeChat(a, 's1', ['one', 'two'])
  assert.ok(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).pushError, 'the second copy stays local')
  execFileSync('git', ['-C', clone, 'remote', 'set-url', '--push', 'origin', origin])
  const stopped = spawnSync('git', ['-C', clone, 'rebase', '-q', '--exec', 'false', 'HEAD~1'],
    { env: { ...process.env, ...GIT_ENV } })
  assert.notStrictEqual(stopped.status, 0, 'the rebase stopped part way')
  const answer = a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.strictEqual(answer.pushed, true, JSON.stringify(answer))
  const own = committed(origin).find(file => file.startsWith('shop/s1/'))
  const text = execFileSync('git', ['--git-dir', origin, 'show', `main:${own}`], { encoding: 'utf8' })
  assert.match(text, /two/, 'the local commit reached the repo')
})

test('a move away from a repo takes the copies other computers pushed since the last pull', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin)
  const b = gitComputer('b', origin)
  writeChat(b, 's1', ['from b'])
  assert.strictEqual(b.sync('out', path.join(b.chatDir, 's1.jsonl'), b.root).pushed, true)
  const target = tempDir('target')
  assert.strictEqual(a.sync('move', 'folder', target).moved, 1)
  assert.strictEqual(fs.readdirSync(path.join(target, 'shop', 's1')).length, 1)
})

test('Google Drive is found under its folder name in the computer\'s language', () => {
  const { syncPlaces } = require(path.join(SCRIPTS, 'places.cjs'))
  for (const name of ['My Drive', 'Mi unidad', 'Meine Ablage']) {
    const home = tempDir('home')
    fs.mkdirSync(path.join(home, name))
    const drive = syncPlaces(home).find(place => place.service === 'Google Drive')
    assert.strictEqual(drive && drive.path, path.join(home, name), name)
  }
})

test('a session start that runs out of time keeps what it did, and the next one goes on', () => {
  const a = computer('a', tempDir('folder'))
  for (const id of ['s1', 's2', 's3']) writeChat(a, id, [id])
  const out = execFileSync(process.execPath, [SYNC, 'in', a.chatDir, a.root, 'other'],
    { env: { ...a.env, CHAT_SYNC_RUN_BUDGET_MS: '0' }, encoding: 'utf8' })
  const first = JSON.parse(out)
  assert.strictEqual(first.more, true)
  assert.ok(first.sent.length < 3, 'the run stopped at its deadline')
  const second = a.sync('in', a.chatDir, a.root, 'other')
  assert.strictEqual(second.more, undefined)
  assert.strictEqual(first.sent.length + second.sent.length, 3, 'the next start sent only the rest')
})

test('a move into a folder inside the old place copies each chat once and makes no stray folders', () => {
  const first = tempDir('first')
  const a = computer('a', first)
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const inner = path.join(first, 'z-new')
  assert.strictEqual(a.sync('move', 'folder', inner).moved, 1)
  assert.deepStrictEqual(fs.readdirSync(inner), ['shop'])
})

test('a move away from a repo that cannot be read keeps the chats syncing where they did', () => {
  const a = gitComputer('a', bareRepo())
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  execFileSync('git', ['-C', path.join(a.dataDir, 'repo'), 'remote', 'set-url', 'origin', path.join(a.home, 'gone')])
  assert.match(a.sync('move', 'folder', tempDir('target')).error || '', /could not be read/)
  assert.strictEqual(a.sync('status', a.root).place.kind, 'git')
})

test('a push that failed goes up with the next copy, though the chat did not change', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin)
  const clone = path.join(a.dataDir, 'repo')
  writeChat(a, 's1', ['one'])
  execFileSync('git', ['-C', clone, 'remote', 'set-url', '--push', 'origin', path.join(a.home, 'gone')])
  assert.ok(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).pushError, 'the first push fails')
  execFileSync('git', ['-C', clone, 'remote', 'set-url', '--push', 'origin', origin])
  assert.strictEqual(a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root).pushed, true)
  assert.ok(committed(origin).some(file => file.startsWith('shop/s1/')), 'the chat reached the repo')
})

test('a computer with no git name set still commits and pushes its chats', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin)
  const env = { ...a.env, GIT_CONFIG_GLOBAL: gitConfig('[user]\n\tuseConfigOnly = true\n') }
  const identity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  for (const name of identity) delete env[name]
  writeChat(a, 's1', ['one'])
  const answer = JSON.parse(execFileSync(process.execPath, [SYNC, 'out', path.join(a.chatDir, 's1.jsonl'), a.root],
    { env, encoding: 'utf8' }))
  assert.deepStrictEqual(answer, { copied: 's1', pushed: true })
  assert.ok(committed(origin).some(file => file.startsWith('shop/s1/')), 'the chat reached the repo')
})

test('a pull that conflicts is reset to the repo whatever language git speaks', () => {
  const origin = bareRepo()
  const a = gitComputer('a', origin, { LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' })
  writeChat(a, 's1', ['one'])
  a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  const other = tempDir('other')
  const env = { ...process.env, ...GIT_ENV }
  execFileSync('git', ['clone', '-q', origin, other], { env })
  const own = committed(origin).find(file => file.startsWith('shop/s1/'))
  fs.appendFileSync(path.join(other, own), '{"changed":"elsewhere"}\n')
  execFileSync('git', ['-C', other, 'commit', '-qam', 'elsewhere'], { env })
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'HEAD'], { env })
  writeChat(a, 's1', ['one', 'two'])
  const answer = a.sync('out', path.join(a.chatDir, 's1.jsonl'), a.root)
  assert.match(answer.pushError || '', /Another computer changed the chat repo/)
})

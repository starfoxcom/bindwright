// Host-side helper for the chat-sync mod: copies chats between this computer's
// Claude Code chat folder and a sync place, a folder a sync app keeps in step
// across computers or a clone of a private git repo. On the way out each
// computer's project folder and home folder become placeholders; on the way in
// the other computer's paths become this one's.
//   node sync.cjs out <transcript> <projectRoot>
//   node sync.cjs in <chatDir> <projectRoot> [<openSessionId>]
//   node sync.cjs move folder <path> | move git <owner/repo> | move off
//   node sync.cjs places
//   node sync.cjs status
// Each prints one line of JSON.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const GIT_TIMEOUT_MS = 60_000

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function dataDir() {
  return path.join(configDir(), 'mods-data', 'chat-sync')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

// This computer's id: its host name as a label plus a random part kept from the
// first run, so two computers with the same host name still tell each other
// apart. Letters, digits and dashes only, since it names a file in the sync
// place (a Mac's "Sams-MacBook.local" becomes "Sams-MacBook-local").
function machineId() {
  const file = path.join(dataDir(), 'machine.json')
  const saved = readJson(file, null)
  if (saved && saved.id) return saved.id
  const id = `${os.hostname().replace(/[^\w-]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
  writeJson(file, { id })
  return id
}

// Where the chats live: { kind: 'folder', path } | { kind: 'git', repo } | { kind: 'off' }.
function readPlace() {
  return readJson(path.join(dataDir(), 'place.json'), { kind: 'off' })
}

function storeRoot(place) {
  if (place.kind === 'folder') return place.path
  if (place.kind === 'git') return path.join(dataDir(), 'repo')
  return null
}

let sshCommand

// The environment for git and gh: a password, passphrase or host-key question
// fails the command at once instead of waiting, since no one is there to answer
// it. A user's own ssh program is kept, as its options may differ from ssh's.
function quietEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' }
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return env
  if (sshCommand === undefined) {
    const run = spawnSync('git', ['config', '--get', 'core.sshCommand'],
      { cwd: os.homedir(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
    sshCommand = (run.stdout || '').trim()
  }
  if (!sshCommand) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return env
}

function git(cwd, ...args) {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: quietEnv() })
  return { ok: run.status === 0, out: `${run.stdout || ''}${run.stderr || ''}`.trim() }
}

// The project's name in the sync place, the same on every computer: its git
// remote, else its name in .bindwright/project.json, else its folder name.
function projectKey(root) {
  const remote = git(root, 'remote', 'get-url', 'origin')
  if (remote.ok && remote.out) {
    const bare = remote.out.split('\n')[0].replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '')
    return safeName(bare.replace(/:/g, '/').replace(/\.git$/i, ''))
  }
  const project = readJson(path.join(root, '.bindwright', 'project.json'), {})
  const name = project.project && project.project.name
  return safeName(typeof name === 'string' && name.trim() ? name : folderName(root))
}

// The last folder of a path, split on either separator, so one path gives one
// name whichever system reads it.
function folderName(root) {
  return root.split(/[\\/]/).filter(Boolean).pop() || ''
}

function safeName(text) {
  return text.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'project'
}

module.exports = {
  configDir, dataDir, readJson, writeJson, machineId, readPlace, storeRoot, quietEnv, git, projectKey, safeName,
}

if (require.main === module) {
  const { run } = require('./commands.cjs')
  let answer
  try {
    answer = run(process.argv.slice(2))
  } catch (error) {
    answer = { error: String(error && error.message ? error.message : error) }
  }
  process.stdout.write(JSON.stringify(answer) + '\n')
}

// Host-side helper for the chat-sync mod: copies chats between this computer's
// Claude Code chat folder and a sync place, a folder a sync app keeps in step
// across computers or a clone of a private git repo. On the way out each
// computer's project folder and home folder become placeholders; on the way in
// the other computer's paths become this one's.
//   node sync.cjs out <transcript> <projectRoot>
//   node sync.cjs out-later <transcript> <projectRoot>
//   node sync.cjs in <chatDir> <projectRoot> [<openSessionId>]
//   node sync.cjs move folder <path> | move git <owner/repo> | move off
//   node sync.cjs places
//   node sync.cjs status
// Each prints one line of JSON.
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const GIT_TIMEOUT_MS = 60_000

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function dataDir() {
  return path.join(configDir(), 'mods-data', 'chat-sync')
}

// A missing file reads as `fallback`. One that is there but cannot be read or
// parsed stops the helper, so the state it holds is never written over.
function readJson(file, fallback) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`Chat sync could not read ${file}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON, so chat sync left it as it is: ${error.message}`)
  }
}

// Written whole to a temporary file, then renamed over the old one, so another
// helper never reads it half written.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = `${file}.${process.pid}.tmp`
  fs.writeFileSync(next, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(next, file)
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

// The environment for git and gh: a password, passphrase or host-key question
// fails the command at once instead of waiting, since no one is there to answer
// it. Git asks an askpass program before the terminal, and an editor's terminal
// sets one that opens a dialog, so none is passed on (core.askPass is emptied in
// gitSettings). When the user set no ssh program of their own, plain ssh runs in
// batch mode. A program or command the user set (GIT_SSH_COMMAND, GIT_SSH, or
// core.sshCommand as git reads it in the folder `cwd`) runs as they set it, so
// only the time limit stops a question it asks.
function quietEnv(cwd = os.homedir()) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' }
  for (const name of ['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']) delete env[name]
  const isOwnSsh = env.GIT_SSH_COMMAND || env.GIT_SSH || configuredSshCommand(cwd)
  if (!isOwnSsh) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return env
}

// Read again for every call, since a folder's answer changes once its remote is
// set (a conditional include can name the remote's address). With no time left
// it reads as unset, and the call that asked for it does not run.
function configuredSshCommand(cwd) {
  const timeout = callTimeout(GIT_TIMEOUT_MS)
  if (!timeout) return ''
  const run = spawnSync('git', ['config', '--get', 'core.sshCommand'], { cwd, encoding: 'utf8', timeout })
  return (run.stdout || '').trim()
}

// Settings every git call of the mod runs with, the clone included: chat files
// byte for byte whatever the user's line-end setting is, a committed link
// checked out as a plain file, and none of the user's hooks or commit signing,
// which could ask for a passphrase or a key touch with no one there. The hooks
// folder is never made, so git finds no hook in it. The mod commits under its
// own name, so a computer signed in to gh with no git name set commits too. No
// askpass program and no credential helper may ask for anything. GitHub hears
// gh's sign-in after the user's own helpers, so a computer signed in only
// through gh clones, pulls and pushes too.
function gitSettings() {
  const settings = ['core.autocrlf=false', 'core.symlinks=false', 'commit.gpgsign=false',
    `core.hooksPath=${path.join(dataDir(), 'no-hooks')}`, 'user.name=chat-sync', 'user.email=chat-sync@localhost',
    'core.askPass=', 'credential.interactive=false', 'credential.https://github.com.helper=!gh auth git-credential']
  return settings.flatMap(setting => ['-c', setting])
}

// One deadline for the whole run: every git and gh call gets the smaller of its
// own limit and the time left, so the calls never add up past it.
let deadline = Infinity

function setDeadline(at) {
  deadline = at
}

function callTimeout(ownMs) {
  return Math.max(0, Math.min(ownMs, Math.floor(deadline - Date.now())))
}

const OUT_OF_TIME = 'Chat sync ran out of time for this run; the next one goes on.'

// A file in a clone's .git folder naming the repo it is a clone of.
const CLONE_OF = 'chat-sync-repo'

// The repo the clone at `store` was made of; null when the clone has no record.
function cloneOf(store) {
  try {
    return fs.readFileSync(path.join(store, '.git', CLONE_OF), 'utf8').trim()
  } catch {
    return null
  }
}

// Runs git or gh with the environment from `quietEnv(envCwd)`. The timeout is
// taken once that environment is built, since building it can run git too.
// Null when no time is left, as a timeout of 0 would mean no limit at all.
function timedRun(command, args, ownMs, envCwd) {
  const env = quietEnv(envCwd)
  const timeout = callTimeout(ownMs)
  if (!timeout) return null
  return spawnSync(command, args, { encoding: 'utf8', timeout, env })
}

function git(cwd, ...args) {
  const run = timedRun('git', [...gitSettings(), '-C', cwd, ...args], GIT_TIMEOUT_MS, cwd)
  if (!run) return { ok: false, out: OUT_OF_TIME }
  const ok = run.status === 0
  const out = `${run.stdout || ''}${run.stderr || ''}`.trim()
  const isMissing = Boolean(run.error && run.error.code === 'ENOENT')
  return { ok, code: run.status, isMissing, out: ok || out ? out : stopReason(`git ${args[0]}`, run) }
}

// Why a command that printed nothing failed: it timed out, could not start, or
// only exited with a code.
function stopReason(name, run) {
  if (run.error && run.error.code === 'ETIMEDOUT') return `${name} did not finish within its time limit.`
  if (run.error) return `${name} could not run: ${run.error.message}`
  return `${name} failed (exit code ${run.status}).`
}

const NO_GIT_HERE = 'This project is a git repo, but this session cannot find git to read its remote, '
  + 'so chat sync did nothing. Install git, or make sure it is on the PATH Claude Code starts with.'

// The project's name in the sync place, the same on every computer whatever is
// installed on it: its git remote, else its name in .bindwright/project.json,
// else its folder name. A project outside any git repo never asks git. Inside
// one, the repo's own remote setting decides: set (exit code 0) names it,
// unset (exit code 1, on every git version) moves on to the other two, and any
// other end (git missing, out of time, or a folder git will not take as a repo,
// such as one owned by another user, which `--local` turns into an error)
// stops the run, since a guessed name would split the project's chats from
// those of a computer whose git answered.
function projectKey(root) {
  const top = repoTop(root)
  const remote = top ? git(root, 'config', '--local', '--get', 'remote.origin.url') : { code: 1 }
  if (remote.code !== 0 && remote.code !== 1) {
    if (remote.isMissing) throw new Error(NO_GIT_HERE)
    if (remote.out === OUT_OF_TIME) throw new Error(OUT_OF_TIME)
    throw new Error(`Chat sync could not read this project's git remote, so it did nothing this run: ${remote.out}`)
  }
  if (remote.code === 0 && remote.out) {
    return remoteKey(remote.out.split('\n')[0], path.relative(top, path.resolve(root)).split(path.sep))
  }
  let project = {}
  try {
    project = readJson(path.join(root, '.bindwright', 'project.json'), {})
  } catch {
    // The project's own file, broken or not: its folder name still names it.
  }
  const saved = project.project && project.project.name
  const name = (typeof saved === 'string' && saved.trim() ? saved : folderName(root)).trim()
  return keyOf(name, ['name', name])
}

// A project's name from its remote: host, owner and repo in lower case, as
// GitHub reads them, then the path of the project's folder below the repo's
// top, so two projects of one repo (a monorepo's packages) keep their chats
// apart. Every spelling of one remote gives one name: https or ssh, any user
// or port, and GitHub's ssh over port 443 (ssh.github.com).
function remoteKey(url, insideParts) {
  const hasScheme = /^[a-z+]+:\/\//i.test(url)
  let bare = url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '')
  if (hasScheme) bare = bare.replace(/^([^/:]+):\d+\//, '$1/')
  const parts = bare.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase().split(/[:/]/).filter(Boolean)
  if (parts[0] === 'ssh.github.com') parts[0] = 'github.com'
  const inside = insideParts.filter(Boolean)
  return keyOf([...parts, ...inside].join('-'), ['remote', parts, inside])
}

// The sync place's folder for a project: a readable label, then a hash of the
// project's exact identity in lower-case hex. Two different identities never
// share a folder, whatever alphabet, dots or case their names hold, even on a
// disk that ignores case, and one identity names the same folder everywhere.
function keyOf(label, identity) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12)
  return `${safeName(label.slice(0, 60))}-${hash}`
}

// The nearest folder at or above `root` that holds `.git` (a folder, or the
// file a worktree or submodule keeps), found without running git; null when
// there is none.
function repoTop(root) {
  let folder = path.resolve(root)
  for (;;) {
    if (fs.existsSync(path.join(folder, '.git'))) return folder
    const parent = path.dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
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
  configDir, dataDir, readJson, writeJson, machineId, readPlace, storeRoot, quietEnv, gitSettings, git,
  setDeadline, callTimeout, timedRun, OUT_OF_TIME, CLONE_OF, cloneOf, stopReason, projectKey,
}

// Starts `out` in a process of its own and returns at once, for a session's
// end: the end gives its hooks well under 2 s and stops what they wait on, so
// the copy runs on after Claude Code exits, on its own limit, and never stops
// halfway through a commit. Nothing is left to show its answer to; whatever
// it could not send goes at the next session start.
function startOutLater(args) {
  const env = { ...process.env }
  delete env.CHAT_SYNC_DEADLINE
  const child = spawn(process.execPath, [__filename, 'out', ...args],
    { detached: true, stdio: 'ignore', windowsHide: true, env })
  child.unref()
  return { started: 'out' }
}

function main([command, ...args]) {
  if (command === 'out-later') return startOutLater(args)
  return require('./commands.cjs').run([command, ...args])
}

if (require.main === module) {
  let answer
  try {
    answer = main(process.argv.slice(2))
  } catch (error) {
    answer = { error: String(error && error.message ? error.message : error) }
  }
  process.stdout.write(JSON.stringify(answer) + '\n')
}

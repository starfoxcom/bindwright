// Finds the folders that sync apps keep in step on this computer, so setup can
// offer them by name: Google Drive, OneDrive, Dropbox, iCloud Drive and
// Syncthing, each at the places its desktop app uses by default.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

function isFolder(folder) {
  try {
    return fs.statSync(folder).isDirectory()
  } catch {
    return false
  }
}

function children(folder) {
  try {
    return fs.readdirSync(folder)
  } catch {
    return []
  }
}

// Dropbox writes where its folder is in info.json, wherever the user moved it.
function dropboxFolders(home) {
  const infos = [
    path.join(process.env.APPDATA || '', 'Dropbox', 'info.json'),
    path.join(process.env.LOCALAPPDATA || '', 'Dropbox', 'info.json'),
    path.join(home, '.dropbox', 'info.json'),
  ]
  const found = []
  for (const file of infos) {
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const account of Object.values(info)) if (account && account.path) found.push(account.path)
    } catch {
      // No Dropbox, or not at this spot.
    }
  }
  return [...found, path.join(home, 'Dropbox')]
}

// macOS keeps every File Provider app's folder under ~/Library/CloudStorage.
function cloudStorage(home) {
  const root = path.join(home, 'Library', 'CloudStorage')
  return children(root).map(name => {
    const folder = path.join(root, name)
    if (/^GoogleDrive-/i.test(name)) return { service: 'Google Drive', path: path.join(folder, 'My Drive') }
    if (/^OneDrive/i.test(name)) return { service: 'OneDrive', path: folder }
    if (/^Dropbox/i.test(name)) return { service: 'Dropbox', path: folder }
    return null
  }).filter(Boolean)
}

function windowsDrives() {
  if (process.platform !== 'win32') return []
  return 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => path.join(`${letter}:\\`, 'My Drive'))
}

// Each sync folder found here, as { service, path }, one entry per folder.
function syncPlaces(home = os.homedir()) {
  const candidates = [
    ...cloudStorage(home),
    { service: 'Google Drive', path: path.join(home, 'My Drive') },
    ...windowsDrives().map(folder => ({ service: 'Google Drive', path: folder })),
    ...children(home).filter(name => /^OneDrive( - .+)?$/.test(name))
      .map(name => ({ service: 'OneDrive', path: path.join(home, name) })),
    ...dropboxFolders(home).map(folder => ({ service: 'Dropbox', path: folder })),
    { service: 'iCloud Drive', path: path.join(home, 'iCloudDrive') },
    { service: 'iCloud Drive', path: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') },
    { service: 'Syncthing', path: path.join(home, 'Sync') },
  ]
  const seen = new Set()
  return candidates.filter(place => {
    const key = path.resolve(place.path).toLowerCase()
    if (seen.has(key) || !isFolder(place.path)) return false
    seen.add(key)
    return true
  })
}

module.exports = { syncPlaces }

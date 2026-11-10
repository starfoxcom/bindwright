// A script the host runs, named by drive path in either slash style: on Windows the only words of a start command
// sure to name a file Start needs. A bare program (`C:/Windows/System32/wsl`), a file the start creates (a cid
// file, a log) and a word with a space carrying arguments are not scripts. Off Windows a path can as well live in
// a container, a VM or a remote host, so nothing is checked there.
const SCRIPT_PATH = /^[A-Za-z]:[\\/][^\s]*\.(?:vbs|vbe|js|jse|wsf|cmd|bat|ps1)$/i

/** Every word of a start command that names a script on this Windows host, in order; none off Windows. */
export function startScripts(argv: unknown, isWindows: boolean): string[] {
  if (!isWindows || !Array.isArray(argv)) return []
  return argv.filter((word): word is string => typeof word === 'string' && SCRIPT_PATH.test(word))
}

/** A path split into the folder that holds it and the file's name; backslashes read as slashes. */
export function splitPath(path: string): { folder: string; name: string } {
  const normal = path.replace(/\\/g, '/')
  const slash = normal.lastIndexOf('/')
  // A root keeps its slash (`/` or `C:/`); any other folder is named without one.
  const isRoot = /^(?:[A-Za-z]:)?\/$/.test(normal.slice(0, slash + 1))
  return { folder: isRoot ? normal.slice(0, slash + 1) : normal.slice(0, slash), name: normal.slice(slash + 1) }
}

/** Whether a folder's entry is the file: Windows names match without regard to case. */
export function isSameName(entry: string, name: string): boolean {
  return entry.toLowerCase() === name.toLowerCase()
}

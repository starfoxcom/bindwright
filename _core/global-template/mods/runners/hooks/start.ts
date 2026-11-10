// A file path a start command names, in this host's form: a drive path in either slash style on Windows, a path
// from the root through at least one folder elsewhere, never ending in a slash (that names a folder). A word with
// a space carries arguments (`bash -c '...'`), a lone `/c` is a Windows switch, and a Linux path on Windows lives
// inside WSL, where the host cannot list it.
const WINDOWS_PATH = /^[A-Za-z]:[\\/][^\s]*[^\s\\/]$/
const ROOT_PATH = /^\/[^/\s]+\/[^\s]*[^\s/]$/

/** Every word of a start command that names a file on this host, in order; none when it is not a list. */
export function startPaths(argv: unknown, isWindows: boolean): string[] {
  if (!Array.isArray(argv)) return []
  const pattern = isWindows ? WINDOWS_PATH : ROOT_PATH
  return argv.filter((word): word is string => typeof word === 'string' && pattern.test(word))
}

/** A path split into the folder that holds it and the file's name; backslashes read as slashes. */
export function splitPath(path: string): { folder: string; name: string } {
  const normal = path.replace(/\\/g, '/')
  const slash = normal.lastIndexOf('/')
  // A root keeps its slash (`/` or `C:/`); any other folder is named without one.
  const isRoot = /^(?:[A-Za-z]:)?\/$/.test(normal.slice(0, slash + 1))
  return { folder: isRoot ? normal.slice(0, slash + 1) : normal.slice(0, slash), name: normal.slice(slash + 1) }
}

/**
 * Whether a folder's entry is the file. Names match without regard to case: Windows and macOS folders ignore it,
 * and on Linux the cost is a missed flag, never a false one.
 */
export function isSameName(entry: string, name: string): boolean {
  return entry.toLowerCase() === name.toLowerCase()
}

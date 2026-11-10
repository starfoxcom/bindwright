// The path a start command names, in this host's form: a drive path in either slash style on Windows, a path
// from the root through at least one folder elsewhere. A word with a space carries arguments (`bash -c '...'`),
// a lone `/c` is a Windows switch, and a Linux path on Windows lives inside WSL, where the host cannot list it.
const WINDOWS_PATH = /^[A-Za-z]:[\\/][^\s]*$/
const ROOT_PATH = /^\/[^/\s]+\/[^\s]*$/

/** The first word of a start command that names a file on this host, or undefined when none does. */
export function startPath(argv: unknown, isWindows: boolean): string | undefined {
  if (!Array.isArray(argv)) return undefined
  const pattern = isWindows ? WINDOWS_PATH : ROOT_PATH
  return argv.find((word): word is string => typeof word === 'string' && pattern.test(word))
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
export function isSameName(entry: string, name: string, isWindows: boolean): boolean {
  return isWindows ? entry.toLowerCase() === name.toLowerCase() : entry === name
}

// A drive path in either slash style, never ending in a slash (that names a folder): on Windows the only words of
// a start command sure to name a file on this host. A word with a space carries arguments, a lone `/c` is a
// switch, and a Linux path lives inside WSL, where the host cannot list it. Elsewhere a path can as well live in
// a container, a VM or a remote host, so nothing is checked there.
const WINDOWS_PATH = /^[A-Za-z]:[\\/][^\s]*[^\s\\/]$/

/** Every word of a start command that names a file on this Windows host, in order; none off Windows. */
export function startPaths(argv: unknown, isWindows: boolean): string[] {
  if (!isWindows || !Array.isArray(argv)) return []
  return argv.filter((word): word is string => typeof word === 'string' && WINDOWS_PATH.test(word))
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

// A drive path in either slash style, or a path from the root through at least one folder: the words of a
// start command that name a file. A lone `/c` is a Windows switch, not a path.
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/[^/\s]+\/)/

/** The first word of a start command that is an absolute path, or undefined when none is. */
export function startPath(argv: string[] | undefined): string | undefined {
  return argv?.find(word => ABSOLUTE_PATH.test(word))
}

/** A path split into the folder that holds it and the file's name; backslashes read as slashes. */
export function splitPath(path: string): { folder: string; name: string } {
  const normal = path.replace(/\\/g, '/')
  const slash = normal.lastIndexOf('/')
  // A root keeps its slash (`/` or `C:/`); any other folder is named without one.
  const isRoot = /^(?:[A-Za-z]:)?\/$/.test(normal.slice(0, slash + 1))
  return { folder: isRoot ? normal.slice(0, slash + 1) : normal.slice(0, slash), name: normal.slice(slash + 1) }
}

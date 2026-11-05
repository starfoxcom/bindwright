import type { RunnerView } from '../types'

const GIB = 1024 ** 3

// WSL's disk file grows as files are written and never shrinks by itself. Compacting gives back the gap
// between the file and the data inside, and it is a manual step, so the row flags only a gap that is worth it.
export const COMPACT_GAP_BYTES = 10 * GIB

const isNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value !== ''

/** Whether a `wsl` field is absent, or names both the distro and its disk file. */
export function isOptionalWsl(wsl: unknown): boolean {
  if (wsl === undefined) return true
  const { distro, disk } = (wsl ?? {}) as Record<string, unknown>
  return isNonEmptyString(distro) && isNonEmptyString(disk)
}

/** The whole number on the last non-empty line of a command's output, or null. */
export function parseWholeNumber(text: string): number | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const last = lines[lines.length - 1] ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/** The bytes in use from `df -B1 --output=used /`: a header line, then the number. */
export function parseUsedBytes(dfText: string): number | null {
  return parseWholeNumber(dfText)
}

/** The disk row's text, or undefined until both the disk size and the data inside it are read. */
export function diskText(row: RunnerView): string | undefined {
  if (row.diskBytes === undefined || row.usedBytes === undefined) return undefined
  const gb = (bytes: number) => (bytes / GIB).toFixed(1)
  const isWorthCompacting = row.diskBytes - row.usedBytes >= COMPACT_GAP_BYTES
  return `disk ${gb(row.diskBytes)} GB (${gb(row.usedBytes)} used${isWorthCompacting ? ', compact' : ''})`
}

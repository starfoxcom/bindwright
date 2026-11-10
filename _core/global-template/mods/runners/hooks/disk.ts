import type { RunnerView } from '../types'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

// WSL's disk file grows as files are written and never shrinks by itself. Compacting, or trimming a sparse
// file, gives back the gap between the file and the data inside. Both are manual steps, so the row flags
// only a gap that is worth it.
export const COMPACT_GAP_BYTES = 10 * GIB

// While the row is on: the data inside needs df, which boots the distro, so it is read more often than the file size.
export const USED_READ_MS = 60_000
export const SIZE_READ_MS = 15 * 60_000
// Allocated bytes this far under the file's length mark a sparse file: fstrim can return that unallocated space.
const SPARSE_SLACK_BYTES = MIB

/** One disk entry's stored reading: when each figure was read, and the figures themselves. */
export type DiskRecord = {
  sizeAt?: number
  usedAt?: number
  /** The runner's on state at the last check; a change of it reads both figures. */
  isOn?: boolean
  /** The file's allocated bytes. */
  diskBytes?: number
  usedBytes?: number
  isSparse?: boolean
}

/** Which figures to read on this check. */
export type DueReads = { size: boolean; used: boolean }

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

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

/** The file's length and allocated bytes, from the `size blocks*512` line the stat script prints. */
export function parseStat(text: string): { size: number; allocated: number } | null {
  const numbers = text.trim().split(/\s+/)
  if (numbers.length !== 2 || !numbers.every(number => /^\d+$/.test(number))) return null
  return { size: Number(numbers[0]), allocated: Number(numbers[1]) }
}

/** Whether the file's allocated bytes fall short of its length by more than 1 MiB. */
export function isSparseFile(stat: { size: number; allocated: number }): boolean {
  return stat.size - stat.allocated > SPARSE_SLACK_BYTES
}

// A figure is due when it was never read, when its time lies ahead of now (a clock set back),
// or when its interval has passed.
const isDue = (readAt: number | undefined, intervalMs: number, now: number): boolean =>
  readAt === undefined || now < readAt || now - readAt >= intervalMs

/** The figures due now: none while the row is off, both after a change of its on state. */
export function dueReads(last: DiskRecord | undefined, isOn: boolean, now: number): DueReads {
  if (!isOn) return { size: false, used: false }
  if (last?.isOn !== true) return { size: true, used: true }
  return { size: isDue(last.sizeAt, SIZE_READ_MS, now), used: isDue(last.usedAt, USED_READ_MS, now) }
}

/** The stored fields that have the right type; anything else, or a store with no record, reads as unset. */
export function readRecord(value: unknown): DiskRecord {
  const stored = (value ?? {}) as Record<string, unknown>
  const numberOrUndefined = (field: unknown) => (isFiniteNumber(field) ? field : undefined)
  const booleanOrUndefined = (field: unknown) => (typeof field === 'boolean' ? field : undefined)
  return {
    sizeAt: numberOrUndefined(stored.sizeAt),
    usedAt: numberOrUndefined(stored.usedAt),
    isOn: booleanOrUndefined(stored.isOn),
    diskBytes: numberOrUndefined(stored.diskBytes),
    usedBytes: numberOrUndefined(stored.usedBytes),
    isSparse: booleanOrUndefined(stored.isSparse),
  }
}

/** The disk row's text, or undefined until both the disk size and the data inside it are read. */
export function diskText(row: RunnerView): string | undefined {
  if (row.diskBytes === undefined || row.usedBytes === undefined) return undefined
  const gb = (bytes: number) => (bytes / GIB).toFixed(1)
  const isWorthReclaiming = row.diskBytes - row.usedBytes >= COMPACT_GAP_BYTES
  const reclaimWord = row.isSparse ? 'trim' : 'compact'
  return `disk ${gb(row.diskBytes)} GB (${gb(row.usedBytes)} used${isWorthReclaiming ? `, ${reclaimWord}` : ''})`
}

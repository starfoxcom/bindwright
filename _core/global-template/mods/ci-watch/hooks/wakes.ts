// Keeping each settled watch to one wake. Pure, no engine access.

import type { Watch } from '../types'

// True when the saved file already records this watch as settled: another instance woke the session, or
// holds the wake pending, which the live instance sends.
export function isRecorded(saved: readonly Watch[] | undefined, watch: Watch): boolean {
  const there = saved?.find(w => w.repo === watch.repo && w.number === watch.number && w.headSha === watch.headSha)
  return there?.outcome !== undefined
}

// A last guard against a second wake from the same instance (two of its polls settling one watch). A
// hot reload's instances may not share this global (see hooks/owner.ts), so across instances the
// owner file and `isRecorded` are what keep a wake to one.
export const wakeKey = (watch: Watch) => `${watch.id ?? ''}|${watch.repo}#${watch.number}@${watch.headSha}`

export function claimWake(watch: Watch): boolean {
  const shared = globalThis as { __ciWatchWoken?: Set<string> }
  const woken = (shared.__ciWatchWoken ??= new Set())
  const key = wakeKey(watch)
  if (woken.has(key)) return false
  woken.add(key)
  return true
}

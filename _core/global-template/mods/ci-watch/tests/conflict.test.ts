import { expect, test } from 'claude-code/testing'

import { summary } from '../hooks/view'
import type { Watch } from '../types'
import { world } from './world'

// A PR that conflicts with its base gets only some checks, so their pass judged nothing.

const BASE: Watch = { repo: 'o/r', number: 7, headSha: 'a1', startedAt: 0, checks: {}, stablePolls: 0 }
const POLL_MS = 30_000

test('a pass on a PR that conflicts with its base wakes with the conflict and counts no round', async ($, on) => {
  const { seen, clock } = world(on)
  seen.bucket = 'pass'
  seen.mergeable = 'CONFLICTING'
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let i = 0; i < 4; i++) await clock.advance(POLL_MS)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('conflicts with its base branch')
  expect(seen.prompts[0]).not.toContain('settled with no failure')
  expect(seen.files.has('C:/Users/me/.claude/mods-data/ci-watch/rounds.json')).toBe(false)
})

test('the row of a conflicting pass names the conflict instead of a green pass', () => {
  const conflicting = { ...BASE, checks: { attribution: 'pass' }, outcome: 'passed' as const, isConflicting: true }
  expect(summary(conflicting)).toEqual({ text: '⚠️ PR 7 · conflicts with its base', color: 'yellow' })
})

test('a pass waits while GitHub still computes whether the PR can merge', async ($, on) => {
  const { seen, clock } = world(on)
  seen.bucket = 'pass'
  seen.mergeable = 'UNKNOWN'
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let i = 0; i < 4; i++) await clock.advance(POLL_MS)
  expect(seen.prompts).toEqual([])
  seen.mergeable = 'MERGEABLE'
  await clock.advance(POLL_MS)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('settled with no failure')
})

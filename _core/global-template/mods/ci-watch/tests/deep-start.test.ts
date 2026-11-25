import { expect, test } from 'claude-code/testing'

import { PR_TITLE, type Seen, world } from './world'

const POLL_MS = 30_000
const MINUTE = 60_000
const OWED = 'triage=reviewable;routine=pass;escalated=yes;deep=none'
const REVIEW_PENDING = [
  { name: 'Review gate', bucket: 'pending' },
  { name: 'Evaluate review outcome', bucket: 'pending' },
]

type Row = { name: string; seen: Partial<Seen>; isEarly: boolean }

// Whether the watch wakes the session within 20 minutes of the push, well before its hour runs out.
const ROWS: Row[] = [
  { name: 'an owed deep review that never started', seen: {}, isEarly: true },
  { name: "another PR's deep run", seen: { deepRuns: ['docs: something else'] }, isEarly: true },
  { name: "this PR's deep run, still working", seen: { deepRuns: [PR_TITLE] }, isEarly: false },
  { name: 'a check besides the review still running', seen: { bucket: 'pending' }, isEarly: false },
  {
    name: 'no deep review owed',
    seen: { gateState: 'triage=reviewable;routine=pending;escalated=no;deep=none' },
    isEarly: false,
  },
]

for (const { name, seen: given, isEarly } of ROWS) {
  test(`deep start: ${name}`, async ($, on) => {
    const { seen, clock } = world(on)
    Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true }, given)
    await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
    for (let poll = 0; poll < (20 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
    expect(seen.prompts.length).toBe(isEarly ? 1 : 0)
  })
}

test('the wake for a deep review that never started says what to re-run, and comes once', async ($, on) => {
  const { seen, clock } = world(on)
  Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (90 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('o/r#7: the review gate waits for a deep review')
  expect(seen.prompts[0]).toContain('gh run rerun')
  expect(seen.prompts[0]).not.toContain('Checks finished')
})

test("a deep run found started is not looked up again", async ($, on) => {
  const { seen, clock } = world(on)
  Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true, deepRuns: [PR_TITLE] })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (30 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.ghCalls.filter(call => call.includes('/runs?')).length).toBe(1)
})

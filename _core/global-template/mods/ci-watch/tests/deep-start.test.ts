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

// Whether the watch wakes the session within 22 minutes of the push, well before its hour runs out.
const ROWS: Row[] = [
  { name: 'an owed deep review that never started', seen: {}, isEarly: true },
  { name: "another PR's deep run", seen: { deepRuns: ['docs: something else'] }, isEarly: true },
  {
    name: "this PR's deep run, still working, however early it was created",
    seen: { deepRuns: [PR_TITLE] },
    isEarly: false,
  },
  { name: 'a check besides the review still running', seen: { bucket: 'pending' }, isEarly: false },
  { name: 'a check besides the review failed', seen: { bucket: 'fail' }, isEarly: false },
  { name: 'a PR renamed since the gate first ran', seen: { renamedAt: ['1970-01-01T00:05:00Z'] }, isEarly: false },
  { name: 'a PR renamed before the gate first ran', seen: { renamedAt: ['1969-12-31T00:00:00Z'] }, isEarly: true },
  {
    name: 'a routine re-run on the same head still working, the label still on',
    seen: { gateState: 'triage=reviewable;routine=pending;escalated=yes;deep=none' },
    isEarly: false,
  },
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
    for (let poll = 0; poll < (22 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
    expect(seen.prompts.length).toBe(isEarly ? 1 : 0)
  })
}

test('the wake for a deep review that never started says to tell the user, and comes once', async ($, on) => {
  const { seen, clock } = world(on)
  Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (65 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('o/r#7: the review gate waits for a deep review')
  expect(seen.prompts[0]).toContain('Tell the user, and start no review yourself')
  expect(seen.prompts[0]).not.toContain('Checks finished')
})

test('a deep run created just after the gate turned owed is found, not missed', async ($, on) => {
  const { seen, clock } = world(on)
  Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (16 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  seen.deepRuns = [PR_TITLE]
  for (let poll = 0; poll < (15 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.prompts.filter(text => text.includes('deep review')).length).toBe(0)
})

test('a routine review that blocked is named in the wake', async ($, on) => {
  const { seen, clock } = world(on)
  const rows = [{ name: 'Review gate', bucket: 'pending' }, { name: 'Evaluate review outcome', bucket: 'fail' }]
  const gateState = 'triage=reviewable;routine=block;escalated=yes;deep=none'
  Object.assign(seen, { bucket: 'pass', rows, gateState, isReadable: true })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (22 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('Meanwhile Evaluate review outcome failed')
})

test('during an Actions incident the incident wake keeps its place', async ($, on) => {
  const { seen, clock } = world(on)
  const incident = { name: 'Incident with Actions', status: 'investigating', components: [{ name: 'Actions' }] }
  const status = JSON.stringify({ incidents: [incident] })
  Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true, status })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (22 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.prompts.some(text => text.includes('Incident with Actions'))).toBe(true)
  expect(seen.prompts.some(text => text.includes('waits for a deep review'))).toBe(false)
})

test('a deep run found on one head is looked for again on the next', async ($, on) => {
  const { seen, clock } = world(on)
  Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true, deepRuns: [PR_TITLE] })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (22 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  Object.assign(seen, { head: 'b2', deepRuns: [] })
  for (let poll = 0; poll < (22 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('the review gate waits for a deep review')
})

test("a deep run found started is not looked up again", async ($, on) => {
  const { seen, clock } = world(on)
  Object.assign(seen, { bucket: 'pass', rows: REVIEW_PENDING, gateState: OWED, isReadable: true, deepRuns: [PR_TITLE] })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  for (let poll = 0; poll < (30 * MINUTE) / POLL_MS; poll++) await clock.advance(POLL_MS)
  expect(seen.ghCalls.filter(call => call.includes('status=in_progress')).length).toBe(1)
})

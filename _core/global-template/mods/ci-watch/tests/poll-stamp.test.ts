import { expect, test } from 'claude-code/testing'
import { world } from './world'

const POLL_MS = 30_000

// The tasks mod counts a watch as a coming wake only while this stamp is fresh, so every poll that leaves a
// watch unsettled or holding its wake saves the poll's time and interval.
test('each poll saves a watch it still waits on with the poll time and interval', async ($, on) => {
  const { seen, clock } = world(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const saved = () => JSON.parse(seen.files.get('C:/Users/me/.claude/mods-data/ci-watch/s1.json') ?? '{}').watches[0]
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' } as never)
  await clock.advance(POLL_MS)
  const first = saved()
  expect([first.outcome, first.pollMs]).toEqual([undefined, POLL_MS])
  await $.turn.start({ turnId: 't' } as never)
  seen.bucket = 'pass'
  for (let poll = 0; poll < 3; poll++) await clock.advance(POLL_MS)
  const held = saved()
  expect([held.outcome, held.wakePending]).toEqual(['passed', true])
  await clock.advance(POLL_MS)
  expect(saved().polledAt).toBeGreaterThan(held.polledAt)
  expect(saved().polledAt).toBeGreaterThan(first.polledAt)
})

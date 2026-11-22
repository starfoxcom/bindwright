import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

type Answer = { deny?: string; context?: string[] }

// Just enough engine for the task list to save and for shell and edit calls to answer. `offered` is the
// session's tool list.
function world(on: On, offered = ['TaskCreate', 'TaskUpdate', 'Bash']): void {
  on('tool.list', () => ({ value: offered.map(name => ({ name })) }) as never)
  const files = new Map<string, string>()
  const key = (path: string) => path.replaceAll('\\', '/')
  mock.clock(on, { now: Date.UTC(2026, 10, 22, 9, 0, 0) })
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  on('fs.read', ($, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.root', () => ({ value: 'C:/Repos/x' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: {} }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: {} }) as never)
  on('tool.call', { tool: 'TaskList' }, () => ({ result: { tasks: [] } }) as never)
  on('tool.call', { tool: ['Bash', 'PowerShell', 'Edit', 'Read'] }, () => ({ result: 'ok' }) as never)
}

async function call($: Engine, input: Record<string, unknown>): Promise<Answer> {
  return (await $.tool.call(input as never)) as never as Answer
}

async function started($: Engine): Promise<void> {
  await $.turn.start({ turnId: 't' } as never)
  await call($, { tool: 'TaskCreate', subject: 'ship the fix', description: 'PR #12 is open' })
  await call($, { tool: 'TaskCreate', subject: 'rename', description: 'last step' })
  await call($, { tool: 'TaskUpdate', taskId: '2', metadata: { hold: 'the owner moves the folder' } })
}

test('a commit waits for a list change since the last commit, and shows each open task', async ($, on) => {
  world(on)
  await started($)
  expect((await call($, { tool: 'Bash', command: 'git commit -m "fix: a"' })).deny).toBe(undefined)
  const refused = (await call($, { tool: 'Bash', command: 'git add -u; git commit -m "fix: b"' })).deny ?? ''
  expect(refused).toContain('Update the task list before this commit')
  expect(refused).toContain('#1 "ship the fix" (pending). PR #12 is open')
  expect(refused).toContain('#2 "rename" (on hold, waits on: the owner moves the folder). last step')
  await call($, { tool: 'TaskList' })
  expect((await call($, { tool: 'Bash', command: 'git commit -m "fix: b"' })).deny).toContain('before this commit')
  await call($, { tool: 'TaskUpdate', taskId: '1', description: 'PR #12 open, fix b committed' })
  expect((await call($, { tool: 'PowerShell', command: 'git commit -m "fix: b"' })).deny).toBe(undefined)
})

test('only a git commit waits', async ($, on) => {
  world(on)
  await started($)
  await call($, { tool: 'Bash', command: 'git commit -m first' })
  const rows: [string, boolean][] = [
    ['git -C P:/repo commit -m x', true],
    ['git -c user.name=x commit --amend', true],
    ['git log --grep commit', false],
    ['git push origin main', false],
    ['cd P:/repo; git add -u && git commit -m x', true],
    ['echo "git commit later"', false],
    ['git commit-graph write --reachable', false],
    ['gh pr comment 5 --body "tests pass; git commit is next"', false],
    ["cat > steps.md <<'EOF'\ngit commit -m x\nEOF", false],
    // Claude Code's own commit form, after a comment whose apostrophe opens no quote.
    ["# don't skip the hooks\ngit commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"", true],
    ["echo it\\'s; git commit -m 'x'", true],
    ["echo $'it\\'s'; git commit -m x", true],
    // A quote spanning lines, or a shift, opens no here-doc; a body's own quotes stay text.
    ['gh pr comment 5 --body "notes\nuse cat <<EOF here"\ngit commit -m x', true],
    ['echo $((1<<n))\ngit commit -m x', true],
    ["git commit -F - <<'EOF'\nfix: the \"quoted\" word\nEOF\ngit log", true],
    ['cat <<EOF\nit\'s "half\nEOF\necho "git commit"', false],
    // A long run of options answers at once.
    [`git${' --x'.repeat(200)} log`, false],
  ]
  for (const [command, isRefused] of rows) {
    const answer = await call($, { tool: 'Bash', command })
    expect([command, answer.deny !== undefined]).toEqual([command, isRefused])
  }
  const powerShell: [string, boolean][] = [
    ["# don't skip the hooks\ngit commit -m x", true],
    ["@'\nsee <<EOF\n'@ | Out-File n.md\ngit commit -m x", true],
    ["@'\ngit commit -m x\n'@ | Out-File n.md", false],
    ['git log --grep "a `"commit`" word"', false],
  ]
  for (const [command, isRefused] of powerShell) {
    const answer = await call($, { tool: 'PowerShell', command })
    expect([command, answer.deny !== undefined]).toEqual([command, isRefused])
  }
})

test('a session with no task tool lets every commit through', async ($, on) => {
  world(on, ['Bash'])
  await $.turn.start({ turnId: 't' } as never)
  expect((await call($, { tool: 'Bash', command: 'git commit -m first' })).deny).toBe(undefined)
  expect((await call($, { tool: 'Bash', command: 'git commit -m second' })).deny).toBe(undefined)
})

test('the first edit after a list change names the task in progress, the next one says nothing', async ($, on) => {
  world(on)
  await started($)
  await call($, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  const first = await call($, { tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
  expect((first.context ?? []).join(' ')).toContain('record it on #1 "ship the fix"')
  const second = await call($, { tool: 'Edit', file_path: 'a.ts', old_string: 'b', new_string: 'c' })
  expect((second.context ?? []).join(' ')).not.toContain('Code changed')
})

test('a /clear starts the next session with its first commit held', async ($, on) => {
  world(on)
  await started($)
  await $.session.end({ reason: 'clear', sessionId: 'sess-a' } as never)
  const answer = await call($, { tool: 'Bash', command: 'git commit -m first' })
  expect(answer.deny).toContain('before this commit')
})

test("a subagent's commit is not held", async ($, on) => {
  world(on)
  await started($)
  await call($, { tool: 'Bash', command: 'git commit -m first' })
  const answer = await call($, { tool: 'Bash', command: 'git commit -m second', agentId: 'sub-1' })
  expect(answer.deny).toBe(undefined)
})

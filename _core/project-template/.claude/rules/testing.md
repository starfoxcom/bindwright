---
paths:
  - "**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,java,kt,kts,cs,c,cc,cpp,h,hpp,swift,dart,rb,php,gd,lua,ex,exs,scala}"
---

# Testing

<!-- TOGGLE:code_host_local START -->
A test is code the project pays for on every change, so it ships only when it earns its place.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
A test is code the project pays for on every PR, so it ships only when it earns its place.
<!-- TOGGLE:code_host_local:off END -->

## When a test earns its place

1. It guards something a user would notice break, or a hard contract (a file or save format, a public API, determinism, thread safety).
2. It fails for one reason, and no other test in its file fails for that reason. Near copies merge into one table of named rows.
3. It checks the outcome, never the implementation: no pinning private constants, call counts or internal layout.
4. A check that the old, wrong version fails (a mutant check) only for a formula that already broke once, or for codecs, fixed-point math and determinism. Never by default.
5. A seeded sweep only where no boundary table can list the input: codecs, determinism and range invariants.
6. Benchmarks stay out of the pass or fail suite.
<!-- TOGGLE:code_host_local START -->
7. A test file stays lean: a save point that grows it says why in its message.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
7. A test file stays lean: a PR that grows it says why.
<!-- TOGGLE:code_host_local:off END -->

Review blocks a new test that misses rules 1 to 3. `docs/test-audit.md` holds the method for checking an existing suite against this list.

## Test the real code

A test calls the production function. It never re-implements the logic in the test and checks the copy against itself, and it does not mock the unit under test. Mock only what the unit talks to (network, clock, disk) and only when the real thing is slow or unavailable.

## Cover the edges on purpose

- For logic with ranges or branches, write a table of cases: each boundary, one step either side of it, empty input and the largest supported input. Name every row, so a failure says which case broke.
- Where rule 5 allows a seeded randomized sweep, print the seed on failure so the case can be replayed.
- When fixing a bug, first add the test that fails on the old code, then fix. Keep that test.
- When replacing a formula that already broke once, keep a check that the case table still catches the old, wrong version. If the old version passes the table, the table is too weak.

## Tiers

<!-- TOGGLE:code_host_local START -->
- **Every save point:** fast tests only, a few minutes at most.
- **Before a bigger piece of work is called done:** slow suites (long sweeps, integration, performance), run by hand.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
- **Every PR:** fast tests only, a few minutes at most.
- **Nightly or weekly:** slow suites (long sweeps, integration, performance). A red scheduled run must open or update an issue, because nothing else will surface it.
<!-- TOGGLE:code_host_local:off END -->

## Coverage

Coverage is a report, never a merge gate. A gate rewards tests that execute lines without checking results. Use the report to find untested code worth testing.

## Flaky tests

<!-- TOGGLE:code_host_local START -->
A flaky test is a bug. Quarantine it in the same save point that notices it (skip it, with a line in `ROADMAP.md`), then fix it. Never re-run until green and move on.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
A flaky test is a bug. Quarantine it in the same PR that notices it (skip with a linked issue), then fix it. Never re-run until green and merge.
<!-- TOGGLE:code_host_local:off END -->

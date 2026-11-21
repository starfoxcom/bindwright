---
name: close-session
description: Close a work session. Verifies what is really finished, commits, lands the work, cleans up and hands off to the next session. Use when the maintainer asks for it, or when every task of the session is done; never just because the context is filling up.
---

# /close-session

<!-- TOGGLE:code_host_local START -->
Run the steps in order without asking between them. Stop and ask only before throwing away work that is not in a save point. If `.claude/rules/visual.md` exists and this session changed what people see, do not call that work done until the maintainer has confirmed the visual check.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
Run the steps in order without asking between them. Stop and ask only before a force-push, deleting a branch that holds unmerged work, or rewriting history someone else has pulled. If `.claude/rules/visual.md` exists and this session changed what people see, do not push until the maintainer has confirmed the visual check.
<!-- TOGGLE:code_host_local:off END -->

<!-- TOGGLE:definition_of_done_verification START -->
## Verify what is done

Only when this session claims a feature or milestone complete. Re-read its definition of done (its issue, ROADMAP, design doc or PR description) and mark each item:

- ✅ **verified**: seen working in the running app, with the commit, the screen or route, and a screenshot or log where it applies;
- ⚠️ **partial**: works in some cases; list the gaps;
- ❌ **unmet**: open a follow-up and stop claiming completion.

When `.claude/skills/verify/SKILL.md` exists, say for each change people can see or use whether `/verify` passed before its last commit; one it never ran before is ⚠️ at best.

One ❌ means the feature is not complete. If an item stopped making sense mid-way, change the definition of done in its own commit first; never quietly call a gap "deferred".

<!-- TOGGLE:definition_of_done_verification END -->
<!-- TOGGLE:tracker:file START -->
## Hand-off file

Write `{{PROJECT_NAME_UPPER}}-CONTEXT_YYYY-MM-DD_HH-MM.md` at the repo root and `git rm` the previous one, so exactly one exists. It holds current state only: where the work stands, decisions made and why, what the next session should do first. Rules and conventions stay in `.claude/rules/`.

For the timestamp, use the latest `[time]` line in the conversation if a hook provides one. Otherwise read the local clock: `date '+%Y-%m-%d %H:%M'`, or `Get-Date -Format 'yyyy-MM-dd HH:mm'` in PowerShell. Never hardcode a timezone.

The hand-off names roadmap items by id (`R4`) and never copies their text.

## Roadmap

`ROADMAP.md` lists only the work still ahead, so it cannot fill up with stale history. Create it in this shape if it is missing:

```
# Roadmap

Next id: R8

## Now
<!-- TOGGLE:code_host_local START -->
- R5 Checkout page
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
- R5 Checkout page (branch feature/checkout)
<!-- TOGGLE:code_host_local:off END -->

## Next
- R6 Saved carts

## Later
- R7 Gift cards
```

Edit only the lines for items this session touched:

<!-- TOGGLE:code_host_local START -->
- An item whose work started moves to Now. Now holds at most five items; ask which one waits when a sixth would join.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
- An item whose work started gets the branch in brackets and moves to Now. Now holds at most five items; ask which one waits when a sixth would join.
<!-- TOGGLE:code_host_local:off END -->
- A finished item is deleted here and added to `CHANGELOG.md` in the same commit.
- A new item takes the `Next id`, which then goes up by one. Ids are never reused.

<!-- TOGGLE:tracker:file END -->
## Derived docs

<!-- TOGGLE:tracker:file START -->
Update `README.md` or `CLAUDE.md` when this session changed what they describe, and say which sections changed.
<!-- TOGGLE:tracker:file END -->
<!-- TOGGLE:tracker:github START -->
Update `README.md` or `CLAUDE.md` when this session changed what they describe, and say which sections changed.
<!-- TOGGLE:tracker:github END -->

Then check the living docs are still current: for each behaviour, name, path, command or number the session's diff changed, search `README.md`, `CLAUDE.md`, `docs/` and `.claude/rules/` for the old wording, and fix every claim that no longer holds. Dated records (released changelog entries, dated notes) stay as written. `docs/docs-audit.md` covers a full sweep.

<!-- TOGGLE:code_research:custom START -->
## Code-research count

Run `python3 .claude/scripts/research-adherence.py` from the repo root (`python` on Windows). It reads the transcript and compares calls to {{TOOLS_CODE_RESEARCH_NAME}} with plain code searches that carry no bypass marker: Grep and Glob calls, and shell commands that start with a recursive search. Searches of docs, logs and data, and filters on another command's output, do not count. Report its line. Below 70% means the next session starts by finding out why.

<!-- TOGGLE:code_research:custom END -->
<!-- TOGGLE:code_research_first START -->
## The code-search tool's own close step

When the guidance {{TOOLS_CODE_RESEARCH_NAME}} installed for the agent names a step for the end of a session, such as a report on how its searches did, run it here.

<!-- TOGGLE:code_research_first END -->
## Pruning pass

Rules, tests and memory only ever grow, and a long rule file is where a session reads past a rule. So at most once a month, offer to prune, here or at `/start-session`, whichever runs first. The date of the last pass, offered or run, lives in this clone's git config, which its worktrees share and no commit carries: `git config --local bindwright.lastPruning` prints it, and `git config --local bindwright.lastPruning <YYYY-MM-DD>` sets it. When it prints nothing, set today's date and skip this step, so the first offer comes a month after the first close that runs it; when it is less than 30 days old, skip this step. Otherwise ask once: "It has been a month: look for rules, tests and memory entries nothing uses any more?" On a no, set today's date and go on.

On a yes, list the candidates, each with one line on why:

- Rule text in `.claude/rules/` and `CLAUDE.md` that repeats another file, or names a file, command or setting that no longer exists.
- Tests that are skipped for good, or that fail for the same reason as another test in their file (`.claude/rules/testing.md`, rule 2).
- Memory entries in `~/.claude/projects/<project-slug>/memory/` that name a file or function that no longer exists, repeat another entry, or say what the repo's rules already say.
- Memory entries whose `written:` date is more than 90 days old, to confirm and re-date or drop, and entries with no `written:` date, to date from their `source:` or drop.

This is a report only: write nothing for it, in the repo, the tracker or anywhere else, and leave what to do with each candidate to the user. Then set today's date.

## Project steps

If `.bindwright/session-steps.md` lists "Extra close steps", run them now, except those marked *after the hand-off*: they run at the end, before the last message.

<!-- TOGGLE:code_host_local:off START -->
## Commit and PR

Stage the session's files by name, never `git add -A` or `git add .`. A file `git status` lists that this session did not change stays out of the commit; name it in the last message. Then take the first row that matches:

| Situation | Do |
|---|---|
| Branch goal not finished | Commit the work. No PR. |
<!-- TOGGLE:tracker:file START -->
<!-- TOGGLE:github_actions_paths_ignore_auto_merge START -->
| Only the hand-off file, `ROADMAP.md` and `CHANGELOG.md` changed | Commit and open the PR; it takes the docs-only path in `token-efficiency.md`. |
<!-- TOGGLE:github_actions_paths_ignore_auto_merge END -->
<!-- TOGGLE:github_actions_paths_ignore_auto_merge:off START -->
<!-- TOGGLE:ci_checks START -->
| Only the hand-off file, `ROADMAP.md` and `CHANGELOG.md` changed | Commit and open the PR, watch its checks per `token-efficiency.md`, and merge per `git.md` § Merging. |
<!-- TOGGLE:ci_checks END -->
<!-- TOGGLE:ci_checks:off START -->
| Only the hand-off file, `ROADMAP.md` and `CHANGELOG.md` changed | Commit, open the PR and merge it per `git.md` § Merging. |
<!-- TOGGLE:ci_checks:off END -->
<!-- TOGGLE:github_actions_paths_ignore_auto_merge:off END -->
<!-- TOGGLE:tracker:file END -->
<!-- TOGGLE:branching_model_gitflow START -->
| `hotfix/*` finished | PR to `{{MAIN_BRANCH}}`. After it merges, open the cascade PR: a `chore/cascade-<name>` branch from `origin/{{DEV_BRANCH}}` that merges `origin/{{MAIN_BRANCH}}` with `--no-ff`, into `{{DEV_BRANCH}}`. Done only when the cascade merges. |
| `release/*` finished | Same as a hotfix: PR to `{{MAIN_BRANCH}}`, tag the release commit, then cascade. |
<!-- TOGGLE:branching_model_gitflow END -->
<!-- TOGGLE:ci_checks START -->
| Any other branch finished | Commit, open a PR to `{{DEV_BRANCH}}`, watch the checks, merge once every check has settled and the required ones pass. |

Commit and PR format, `--body-file`, merge style and branch cleanup are in `git.md`; watching checks is in `token-efficiency.md`. Run each post-merge command as its own call.
<!-- TOGGLE:ci_checks END -->
<!-- TOGGLE:ci_checks:off START -->
| Any other branch finished | Run the tests, commit, open a PR to `{{DEV_BRANCH}}`, and merge it once it has the approvals its branch rules ask for. No CI runs here, so the tests you ran are the check. |

Commit and PR format, `--body-file`, merge style and branch cleanup are in `git.md`. Run each post-merge command as its own call.
<!-- TOGGLE:ci_checks:off END -->
<!-- TOGGLE:code_host_local:off END -->
<!-- TOGGLE:code_host_local START -->
## Save point

Commit the session's work as one save point, or one per finished piece, with the message format in `git.md`. Stage the files by name, never `git add -A` or `git add .`. A file `git status` lists that this session did not change stays out of the save point; name it in the last message. The project lives only on this computer: nothing is pushed, and there is no pull request.
<!-- TOGGLE:code_host_local END -->

<!-- TOGGLE:tracker:github START -->
## Hand-off in the tracker

After the commit and PR, so the state records how they ended. For each issue this session worked on, rewrite its `### Current state` per `.claude/rules/tracker.md`: where the work stands, decisions made and why, what the next session should do first. Work without an issue gets one now with the "New item" command, a branch with no PR included. Rules and conventions stay in `.claude/rules/`; session figures (the code-research count, context use) stay in the chat.

Then post a project status update only when this session completed a milestone or a major arc of one, changed the health colour, or changed the plan; `tracker.md` § Project status updates has the shape. Most sessions post none.

<!-- TOGGLE:public_roadmap START -->
Last, bring the public roadmap in line (`tracker.md` § Public roadmap): run `python3 .github/scripts/public_roadmap.py check` (`python` on Windows), fix what it lists in the issues' public summaries, then run it with `push`.
<!-- TOGGLE:public_roadmap END -->

<!-- TOGGLE:tracker:github END -->
<!-- TOGGLE:handoff_file START -->
## Hand-off file

Rewrite `.bindwright/handoff.md`. It stays in this checkout, out of git: the first time, add the line `.bindwright/handoff.md` to the file `git rev-parse --git-path info/exclude` prints (a worktree shares it with its main checkout, but keeps its own hand-off file). It only points at the tracker, in at most ten lines, and never restates an issue's state:

```
# Hand-off (YYYY-MM-DD HH:MM)
- Worked on: #12 (PR #40 waiting on review), #15
- Start with: #13
- Open question: <one line, or none>
```

<!-- TOGGLE:handoff_file END -->

## Steps after the hand-off

Run the extra close steps marked *after the hand-off*, if any: they read this session's finished work and its hand-off.

## Last message

<!-- TOGGLE:code_host_local START -->
> **Session closed.** Everything is in a save point. Start a fresh conversation for the next session.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:ci_checks START -->
> **Session closed.** Everything is committed; [PR #N merged and branches deleted | branch pushed, PR #N waiting on checks | work committed locally on `<branch>`]. Start a fresh conversation for the next session.
<!-- TOGGLE:ci_checks END -->
<!-- TOGGLE:github_no_actions START -->
> **Session closed.** Everything is committed; [PR #N merged and branches deleted | branch pushed, PR #N open | work committed locally on `<branch>`]. Start a fresh conversation for the next session.
<!-- TOGGLE:github_no_actions END -->

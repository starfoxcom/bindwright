# Git rules

## Commits

One logical change per commit. Never mix a feature with a refactor, or a fix with config.

```
<type>(<scope>): <imperative description>
```

- 72 characters max. Imperative verb: `add`, `fix`, `remove`, `update`, `refactor`, `extract`.
- `scope` is the system or layer touched.
- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore` (build, CI, tooling, deps), `data` (app data, configs, assets), `style` (formatting only).
<!-- TOGGLE:attribution_guard START -->
- No AI-attribution lines anywhere: no co-author trailers, "generated with" footers or session links in commits, PR titles, PR bodies or comments. `.claude/settings.json` turns off the harness's own trailers, and the `no-ai-attribution` hook catches the ones written by hand.
<!-- TOGGLE:attribution_guard END -->
<!-- TOGGLE:assistant_files_local START -->

### The assistant's files stay on this computer

`CLAUDE.md`, `.claude/`, `.bindwright/` and the other files setup wrote for the assistant are listed in this clone's `.git/info/exclude`, an ignore list git keeps out of every commit, so they never reach a commit, a push or a pull request.

- Stage files by name. Never `git add -f` an excluded file, and never move its line into `.gitignore`, which the whole team shares.
- Leave those files' names out of commit messages, PR bodies and comments.
- A fresh clone has neither the files nor the list: run `/bindwright:setup` there, which writes the list before any file.
<!-- TOGGLE:assistant_files_local END -->
<!-- TOGGLE:code_host_local START -->

## Save points

A save point is a commit: a saved step you can always go back to. Make one after each piece of work that works, with one change per save point. Stage the files that belong to it with `git add <file>`, then commit with a short message that says what changed, such as `feat(login): add the sign-in form`.

- See what has changed since the last save point with `git status` (which files) and `git diff` (what changed inside them).
- Undo changes you have not saved yet, in one file, with `git restore <file>`.
- Undo a save point you already made with `git revert <commit>`. It adds a new save point that reverses the old one, so nothing is lost.
- Never use `git reset --hard` or a force push. They throw away saved work, and nothing brings it back.
- This project lives only on this computer. Git keeps its history here, but nothing else keeps a copy, so back up the whole folder: copy it to another drive, or keep it in a folder that a cloud-sync service updates.
<!-- TOGGLE:code_host_local END -->

---

<!-- TOGGLE:code_host_local:off START -->
<!-- TOGGLE:branching_model_gitflow START -->
## Branches (Gitflow)

| Branch | From | Merges into |
|---|---|---|
| `{{MAIN_BRANCH}}` | | Production. Every release commit is tagged. |
| `{{DEV_BRANCH}}` | | Integration. Base for all work. |
| `feature/<name>` | `{{DEV_BRANCH}}` | `{{DEV_BRANCH}}` |
| `release/<version>` | `{{DEV_BRANCH}}` | `{{MAIN_BRANCH}}`, then cascade to `{{DEV_BRANCH}}` |
| `hotfix/<name>` | `{{MAIN_BRANCH}}` | `{{MAIN_BRANCH}}`, then cascade to `{{DEV_BRANCH}}` |

- Kebab-case names: `feature/user-auth-flow`.
- Never push directly to `{{MAIN_BRANCH}}` or `{{DEV_BRANCH}}`.
<!-- TOGGLE:default_branch_is_dev START -->
- `{{DEV_BRANCH}}` is the GitHub default branch, so `gh pr create` targets it automatically. Pass `--base {{MAIN_BRANCH}}` only for release and hotfix PRs.
<!-- TOGGLE:default_branch_is_dev END -->
<!-- TOGGLE:default_branch_is_dev:off START -->
- The GitHub default branch is `{{MAIN_BRANCH}}`, so always pass `--base {{DEV_BRANCH}}` to `gh pr create` for work PRs.
<!-- TOGGLE:default_branch_is_dev:off END -->
<!-- TOGGLE:branching_model_gitflow END -->
<!-- TOGGLE:code_host_local:off END -->

<!-- TOGGLE:code_host_local:off START -->
<!-- TOGGLE:branching_model_trunk START -->
## Branches (trunk-based)

| Branch | From | Merges into |
|---|---|---|
| `{{MAIN_BRANCH}}` | | The only long-lived branch. Release commits are tagged. |
| `feature/<name>` | `{{MAIN_BRANCH}}` | `{{MAIN_BRANCH}}` |
| `hotfix/<name>` | `{{MAIN_BRANCH}}` | `{{MAIN_BRANCH}}` |

- Kebab-case names: `feature/user-auth-flow`.
- Never push directly to `{{MAIN_BRANCH}}`.
<!-- TOGGLE:branching_model_trunk END -->
<!-- TOGGLE:code_host_local:off END -->

<!-- TOGGLE:code_host_local:off START -->
### Keep branches current

When the base branch advances, merge it into your open branches before continuing (`git fetch origin`, then `git merge origin/{{DEV_BRANCH}}` on the work branch, then push). Never rewrite a branch someone else has pulled.

### Scope

A branch changes one concern. A tangential bug gets its own branch. Before coding, list the directories the work will touch; anything outside the branch's scope becomes a prerequisite branch and PR that merges first.

### Check the branch before the first edit

Run `git branch --show-current` before editing. Switch or branch first, then edit. If you notice you edited on the wrong branch, stop and say so instead of stashing and moving the work silently.

---

## Merging

<!-- TOGGLE:merge_style:squash START -->
- Work PRs squash-merge: `gh pr merge <pr> --squash --delete-branch`. The PR title becomes the commit, so it must follow the commit format above, in 64 characters or fewer (GitHub appends ` (#123)`). One PR is one logical change; the commits inside it serve review only.
- A branch stacked on a PR that was just squash-merged still carries the parent's commits. Before continuing, run `git rebase --onto origin/{{DEV_BRANCH}} <old-parent-tip>` and force-push the stacked branch.
<!-- TOGGLE:merge_style:squash END -->
<!-- TOGGLE:merge_style:merge START -->
- Every PR merges with a merge commit: `gh pr merge <pr> --merge --delete-branch`. Keep each commit buildable, and read history with `git log --first-parent`.
<!-- TOGGLE:merge_style:merge END -->
<!-- TOGGLE:merge_style:rebase START -->
- Work PRs rebase-merge: `gh pr merge <pr> --rebase --delete-branch`. Every commit must build on its own, so squash fixup commits on the branch before merging.
<!-- TOGGLE:merge_style:rebase END -->
<!-- TOGGLE:branching_model_gitflow START -->
- Release PRs (`{{DEV_BRANCH}}` into `{{MAIN_BRANCH}}`) and cascade PRs (`{{MAIN_BRANCH}}` into `{{DEV_BRANCH}}`) always use `--merge`. Squashing them makes the two branches diverge and turns the next release into a conflict.
<!-- TOGGLE:branching_model_gitflow END -->
- After merging: `--delete-branch` removes the remote branch, but the local one only when it is checked out. Run `git branch -D <name>` if it remains, then confirm with `git branch`.
- Then, when Bindwright's helper is installed (`~/.bindwright/helper/node_modules/bindwright`, which setup installs), run `node "$HOME/.bindwright/helper/node_modules/bindwright/hooks/counts.mjs" send <repo root>` in the background. It sends nothing unless this computer turned on the anonymous review counts, and at most once in 24 hours, so a merge never waits on it.
<!-- TOGGLE:ci_checks START -->
- Re-run a failed CI workflow as a whole (or push again). Re-running only the failed job can leave a required check stuck.
<!-- TOGGLE:ci_checks END -->

<!-- TOGGLE:branching_model_gitflow START -->
### Cascade after every merge into `{{MAIN_BRANCH}}`

GitHub does not copy `{{MAIN_BRANCH}}` back into `{{DEV_BRANCH}}`. After a hotfix or release merges:

```bash
git fetch origin
git checkout -b chore/cascade-<name> origin/{{DEV_BRANCH}}
git merge --no-ff origin/{{MAIN_BRANCH}} -m "chore: cascade <name> into {{DEV_BRANCH}}"
git push -u origin chore/cascade-<name>
gh pr create --base {{DEV_BRANCH}} --title "chore: cascade <name> into {{DEV_BRANCH}}" --body-file <file>
```

The hotfix or release is done only when the cascade PR is merged and its branch deleted.
<!-- TOGGLE:github_no_actions:off START -->

### Workflow file changes

Review workflows triggered by comments or schedules run the copy on the GitHub default branch, and the review app refuses its token to a run whose copy of the review workflow differs from that copy, so its review is never posted.
<!-- TOGGLE:default_branch_is_dev START -->
Because `{{DEV_BRANCH}}` is the default branch, workflow changes are ordinary work PRs into `{{DEV_BRANCH}}`. They reach `{{MAIN_BRANCH}}` with the next release. A hotfix cut while `{{DEV_BRANCH}}` holds unreleased workflow changes will fail that check; release first, then cut the hotfix.
<!-- TOGGLE:default_branch_is_dev END -->
<!-- TOGGLE:default_branch_is_dev:off START -->
Because `{{MAIN_BRANCH}}` is the default branch, a change to `.github/workflows/` lands on `{{MAIN_BRANCH}}` first as a `hotfix/<name>` PR, then cascades to `{{DEV_BRANCH}}`. A workflow change made on a feature branch fails the review check.
<!-- TOGGLE:default_branch_is_dev:off END -->
<!-- TOGGLE:github_no_actions:off END -->
<!-- TOGGLE:branching_model_gitflow END -->

---

## Pull requests

Write the body to a file and pass `--body-file <path>`. Inline bodies get truncated or mangled by the shell.

```
## What
<1-3 bullets>

## Why
<1-2 lines>

## Notes (optional)
<non-obvious decisions, performance impact, manual steps>
```

No empty sections and no generic testing checklist. The body carries what the diff cannot show.

<!-- TOGGLE:pr_reviewers START -->

### Required reviewers

The base branch requires approvals from people. On `gh pr create`, pass `--reviewer <name>` for each name in `advanced.prReviewers` of `.bindwright/project.json` (a person's GitHub name, or `<org>/<team>` for a team). Merge only when `gh pr view <pr> --json reviewDecision` prints `APPROVED` and every check passes; while it prints `REVIEW_REQUIRED` or `CHANGES_REQUESTED`, wait, answer the review, and never try the merge first.
<!-- TOGGLE:pr_reviewers END -->

<!-- TOGGLE:github_actions START -->
Review tiers, the verdict rule and CI watching live in `review-tiers.md` and `token-efficiency.md`.
<!-- TOGGLE:github_actions END -->

---
<!-- TOGGLE:code_host_local:off END -->

## Dead code does not ship

<!-- TOGGLE:code_host_local START -->
Code with no remaining caller is deleted in the same save point that orphaned it. Check with the project's lint or dead-code tool, then judge the result: a symbol reached only through reflection, dependency injection, bindings or serialization is not dead. If a tool reports a false positive, record the exception where the tool reads it instead of silencing the tool.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
Code with no remaining caller is deleted in the same PR that orphaned it. Check with the project's lint or dead-code tool, then judge the result: a symbol reached only through reflection, dependency injection, bindings or serialization is not dead. If a tool reports a false positive, record the exception where the tool reads it instead of silencing the tool.
<!-- TOGGLE:code_host_local:off END -->

## Definition of done

<!-- TOGGLE:ci_checks:off START -->
A feature is done when it works end to end in the running app, not when it compiles. Passing tests are necessary, not sufficient.
<!-- TOGGLE:ci_checks:off END -->
<!-- TOGGLE:ci_checks START -->
A feature is done when it works end to end in the running app, not when it compiles. CI green is necessary, not sufficient.
<!-- TOGGLE:ci_checks END -->

<!-- TOGGLE:precommit_hooks_scaffold START -->
---

## Pre-commit hooks

<!-- TOGGLE:precommit:lefthook START -->
Gate: **lefthook**, config `lefthook.yml`. Activate with `lefthook install`. If `git config core.hooksPath` prints a folder, ask the user to run `git config --local core.hooksPath "$(cd "$(git rev-parse --git-common-dir)" && pwd -P)/hooks"` first (POSIX shell), then activate with `lefthook install --force`: lefthook writes its hooks into whatever folder that setting names, even on `lefthook run`, so a global one would replace the hooks of every repo that shares it. Lefthook 2 refuses a plain install while any such setting exists; `--force` installs into the local folder, while `--reset-hooks-path` would remove the global setting for every repo. With its own folder the repo no longer runs the global folder's hooks, so copy any it still needs (an indexer's sync, say) into its own `post-commit` or `post-checkout`.
<!-- TOGGLE:precommit:lefthook END -->
<!-- TOGGLE:precommit:husky START -->
Gate: **husky**, config `.husky/pre-commit`. Activate with `npm install --save-dev husky && npm pkg set scripts.prepare=husky && npm run prepare`. A `core.hooksPath` that `git config core.hooksPath` prints needs no step: husky sets this repo's own (`.husky/_`), which overrides a global one.
<!-- TOGGLE:precommit:husky END -->
<!-- TOGGLE:precommit:pre-commit START -->
Gate: **pre-commit**, config `.pre-commit-config.yaml`. Activate with `pre-commit install`. It refuses to install while `git config core.hooksPath` prints anything, at any level; removing a global value changes every repo on the machine, so that is the user's call.
<!-- TOGGLE:precommit:pre-commit END -->
<!-- TOGGLE:precommit:simple-git-hooks START -->
Gate: **simple-git-hooks**, config `.simple-git-hooks.json`. Activate with `npx simple-git-hooks`. It installs into `.git/hooks` whatever `core.hooksPath` says, so if `git config core.hooksPath` prints a folder, ask the user to run `git config --local core.hooksPath "$(cd "$(git rev-parse --git-common-dir)" && pwd -P)/hooks"` (POSIX shell) so git looks there.
<!-- TOGGLE:precommit:simple-git-hooks END -->

The hook runs lint, type check and tests before each commit. Do not bypass it with `--no-verify`; fix the failure.

After activating, make a commit the hook must refuse and confirm it is refused: a gate git never runs reports nothing.
<!-- TOGGLE:precommit_hooks_scaffold END -->

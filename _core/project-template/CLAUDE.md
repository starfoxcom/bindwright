# CLAUDE.md

Guidance for Claude Code in this repository. Rules in `.claude/rules/` load on their own; this file holds what they do not.

## Project

**{{PROJECT_NAME}}**: {{ONE_LINE_DESCRIPTION}}

- **Stack:** {{LANGUAGE_AND_FRAMEWORK}}
- **Repo:** {{REPO_URL}}
<!-- TOGGLE:code_host_local START -->
- **Save points:** each piece of work that works is a commit on `{{MAIN_BRANCH}}`, and the project lives only on this computer. See `.claude/rules/git.md`.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
<!-- TOGGLE:branching_model_gitflow START -->
- **Branches:** `{{MAIN_BRANCH}}` holds tagged releases; `{{DEV_BRANCH}}` is where work lands. See `.claude/rules/git.md`.
<!-- TOGGLE:branching_model_gitflow END -->
<!-- TOGGLE:branching_model_trunk START -->
- **Branches:** short-lived branches merge into `{{MAIN_BRANCH}}`; release commits are tagged. See `.claude/rules/git.md`.
<!-- TOGGLE:branching_model_trunk END -->
<!-- TOGGLE:code_host_local:off END -->
- **Commands:** lint `{{LINT_COMMAND}}`, type check `{{TYPECHECK_COMMAND}}`, test `{{TEST_COMMAND}}`.

<!-- TOGGLE:tracker:github START -->
Work is tracked in GitHub issues: `.claude/rules/tracker.md` says where each item's state lives and how to read and update it.
<!-- TOGGLE:tracker:github END -->
<!-- TOGGLE:tracker:file START -->
<!-- TOGGLE:code_host_local START -->
Work is planned in `ROADMAP.md` (Now, Next, Later, one line per item with its id). `/close-session` keeps it current and `/start-session` reads it.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
Work is planned in `ROADMAP.md` (Now, Next, Later, one line per item with its id). `/close-session` keeps it current; `/start-session` checks it against git.
<!-- TOGGLE:code_host_local:off END -->
<!-- TOGGLE:tracker:file END -->

## Language

- Talk to me in **{{CONVERSATION_LANGUAGE}}**.
- Code, comments, identifiers and technical docs are in **{{CODE_LANGUAGE}}**. User-visible strings go through the localization layer when the project has one.

<!-- TOGGLE:code_research_first START -->
## Code research

Find code with `/find` before reading files. This project uses **{{TOOLS_CODE_RESEARCH_NAME}}**; `/find` has the lookup sequence and the only cases where Grep and Glob are allowed. `/close-session` reports how often each was used.

<!-- TOGGLE:code_research_first END -->
## Sessions

- **Start:** `/start-session` reads the current state, proposes a plan and waits for approval before changing code.
- **During:** track multi-step work per `.claude/rules/task-tracking.md`.
<!-- TOGGLE:code_host_local START -->
- **End:** `/close-session` checks what is really finished and makes the save point.
<!-- TOGGLE:code_host_local END -->
<!-- TOGGLE:code_host_local:off START -->
- **End:** `/close-session` checks what is really finished, commits, and opens or merges the PR.
<!-- TOGGLE:code_host_local:off END -->

<!-- TOGGLE:lazy_rules_folder START -->
## Rules loaded on demand

Rules that matter only at certain milestones live in `docs/lazy/` and do not load automatically. `docs/lazy/README.md` lists them and when to read each.

<!-- TOGGLE:lazy_rules_folder END -->
<!-- TOGGLE:memory_system START -->
## Memory

Project memory lives in `~/.claude/projects/<project-slug>/memory/`, indexed by `MEMORY.md`. Save what the repo cannot tell a future session (decisions, preferences, pointers to outside resources), never what the code or git history already records.
<!-- TOGGLE:memory_system END -->

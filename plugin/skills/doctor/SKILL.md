---
name: doctor
description: Check that Bindwright works in this repo and on this machine, and say in plain words what is wrong and how to fix each thing. Changes nothing.
---

# /bindwright:doctor

A read-only health check. It runs the engine's checks and the review gate's own check, then explains each problem with its fix. It changes no file and runs no fix by itself; it offers each fix and runs it only on a yes.

## 1. Run the checks

- Find the repo root with `git rev-parse --show-toplevel`. Outside a git repo, say Bindwright works inside one, and stop.
- Find the helper and pick the engine as setup's step 0 does (`${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`), without installing anything: a helper that is missing or holds another version than the plugin is a finding, fixed by running `/bindwright:setup` or `/bindwright:update`, which offer to install it. With neither, that is the first finding: setup, update and the doctor need Node 18 or later, or Python 3.8 or later.
- Run it with `--doctor <repo root>`. It prints `{"problems": N, "checks": [{"id", "ok", "say", "fix"}, ...]}` in a fixed order: the setup files, the programs the hooks in `~/.claude/settings.json` start, the repo's version, the guard hooks, staged files, the roadmap (only with the file tracker), settings, extras, the CLI. On `{"error": "..."}`, report the message as a finding.
- When `.bindwright/project.json` names a board (`advanced.trackerProject`, `"<owner>/<number>"`), run `gh project view <number> --owner <owner> --format json --jq .public`. `true` is the most serious finding: the board holds the project's full engineering details and anyone can read it. Its fix is `gh project edit <number> --owner <owner> --visibility PRIVATE`, with a clean public copy (`advanced.publicRoadmap`, which `/bindwright:setup` offers) as the safe way to show outsiders the plan. When `gh` is missing or the call fails, say the board's visibility could not be checked and why.
- When `.github/scripts/setup-review-gate.sh` exists, also run `bash .github/scripts/setup-review-gate.sh --check`. Each `MISSING` line is a finding; its fix is running the script without `--check`, which sets the missing pieces up on GitHub.

## 2. Report

- No problems: say so in one line, with the plugin version, the `version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
- Otherwise, one short line per problem: what is wrong (`say`) and what to do (`fix`), most serious first: a public board, then the setup files, then the guards, then the rest. Leave out the checks that passed.
- Offer to run each fix that is a command or a skill, one at a time, and only on a yes.

When a problem looks like a bug in Bindwright itself rather than in this repo (an engine error, a check that contradicts what the user sees), offer `/bindwright:report`.

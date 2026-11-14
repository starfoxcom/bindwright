---
name: join
description: Bring this machine in line with a repo's Bindwright setup after cloning it. Walks through each difference with a yes or no, remembers the answers, then starts the session.
disable-model-invocation: true
---

# /bindwright:join

This skill compares the team's setup in `.bindwright/project.json` with this machine and goes through each difference with the user, one at a time. Nothing changes without a yes, and every answer is remembered so the daily notice and the next join do not ask again. It ends by starting the session, so the user sees the board and the plan.

## 1. Read both sides

- Find the repo root with `git rev-parse --show-toplevel`. If `.bindwright/project.json` is missing, this repo does not use Bindwright; say so and stop.
- Find the helper and pick the engine as setup's step 0 does (`${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`), installing the helper on a yes when it is missing or holds another version than the plugin, then taking out a FindWright copy from an older Bindwright as setup's step 0 paragraph of that name says, and run `--settings <repo root>`. On `{"error": "..."}`, show the message and stop. A message saying a file "was written by a newer Bindwright" means the plugin is older than the repo's setup: tell the user to update the plugin with `/plugin`, and stop.
- If `ignored` is not empty, list it in plain words: those values are not used. Values the project's own `setup` asks for that this plugin does not know are among them; never act on them.

## 2. Tracker access

`settings.tracker.value` says where the work state lives.

- `github`: check `gh auth status`. If it fails, show `gh auth login` and wait for the user. When `advanced.trackerProject` in `.bindwright/project.json` names a board, check `gh project view <number> --owner <owner>` reaches it; a scope error means `gh auth refresh -s project`.
- `file`: nothing to check.

## 3. The code-research tool

`settings.codeResearch` names the tool the project uses. If it is not `none` and the tool is not set up on this machine, offer to set it up the way `/bindwright:setup` step 7 does, from `<helper>/_core/global-template/hooks/code-research-profiles.json`: show each command and run it only on a yes. When the setting is not `required`, the user may keep their own tool instead; record that with `--remember <repo root> --layer local` and `{"codeResearch": "<their tool>"}`.

## 4. The extras

For each extra in `extras` whose `want` is not `false` and that `installed` says is missing, in the order listed:

- Say in one line what it does, and whether the project rates it `required` or `recommended`.
- On a yes, install it the way `/bindwright:setup` step 7 does: a mod with `python "<helper>/engine/home.py" add-mod "<helper>/_core/global-template/mods/<name>"` (mods need CLI 2.1.287 or later; check the version this session runs as setup does, from `AI_AGENT`), a guard with `home.py install-hook`, `global-instructions` by merging `CLAUDE.md.additions` with its marker line, rendered the way setup step 7 says when `.bindwright/global/` is not there. Then remember `{"extras": {"<name>": true}}` with `--layer personal`.
- On a no to a `recommended` extra, remember `{"extras": {"<name>": false}}` with `--layer personal`, so nothing asks again.
- A `required` extra cannot be declined in the settings. On a no, leave it out, and tell the user the project expects it and the daily notice will keep saying so.

Choices are passed on standard input to `--remember <repo root> --layer personal` (every project on this machine) or `--layer local` (only this repo; the engine keeps that file out of git). On `{"error": ...}`, show it and go on with the next extra.

When this run rendered `.bindwright/global/`, remove it at the end the way setup step 7 does, with the engine's `--clean-staging <repo root>`.

Then ask which per-project mods run in this project, as `/bindwright:setup` § "Mods in this project" says, and write the answers as its step 6 does. They go in this person's own `.claude/settings.local.json`, so each teammate picks their own.

Mods load at start-up: if any were installed or turned off here, say the CLI needs a restart.

## 5. Start

Summarise in plain words what was set up, what was declined, and anything still missing. Then run `/start-session`.

Do not commit or push. Outside the repo, change only what the user said yes to.

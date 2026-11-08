---
name: remove
description: Take Bindwright back out. Removes the files setup wrote into this repo and the extras it added to your own config folder, keeps every file you changed unless you say otherwise, and ends with how to uninstall the plugin.
disable-model-invocation: true
argument-hint: "[computer]"
---

# /bindwright:remove

The argument is: `$ARGUMENTS`

This skill undoes what `/bindwright:setup` did: first in this repo, then on this computer, then the plugin itself. It removes only what setup wrote and the user did not change, asks before anything else, and never touches the user's own files. With the argument `computer`, skip the repo part and start at step 4.

Pick the engine as setup does: `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.js"` when `node --version` reports 18 or later, otherwise Python 3.8 or later with `"${CLAUDE_PLUGIN_ROOT}/engine/bind.py"`.

## 1. Check the repo

- Find the repo root with `git rev-parse --show-toplevel`. Outside a repo, or when `.bindwright/pristine.json` is missing, this repo was not set up with Bindwright: say so and go to step 4.
- If `git status --porcelain` shows uncommitted changes, say so and ask whether to continue. On a clean tree the removal reads as one diff and is undone with `git restore`.

## 2. Sort what setup wrote

Run the engine with `--remove-plan <repo root>`. It changes nothing and prints `{"delete": [...], "edited": [...], "merged": [...], "missing": [...], "owned": [...]}`, repo paths, or `{"error": ...}`: show the message and stop.

Tell the user, grouped by kind (rules, skills, hooks, workflows, docs) and not file by file, what each list means for them, and ask:

- **`delete`**: files exactly as setup wrote them. One yes removes them all. Ask separately about the project's own documents among them (`README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`): they describe the project, so offer to keep them, and never remove a `LICENSE` without an explicit yes.
- **`edited`**: files setup wrote that the user changed since. Show what they changed (the repo's copy against the file's text in `.bindwright/pristine.json`) and ask for each one: keep it (recommended) or remove it.
- **`merged`**: shared files such as `CLAUDE.md`, `.claude/settings.json` and `.gitattributes`, which hold the user's own text beside setup's. Take out only setup's parts: the sections and lines that match the text in `.bindwright/pristine.json`, keeping everything the user wrote. For `.claude/settings.json`, work on the JSON: drop the permission entries and hooks the pristine copy has, keep every other entry. Show each result and save it only on a yes. When nothing is left of a file, offer to remove it with the others.
- **`missing`**: already gone; nothing to do.
- **`owned`**: listed in `.bindwright/owned` as the project's own; they stay.

Also offer to take out what setup changed outside those files: the `.claude/settings.local.json` line it added to `.gitignore`, and the `.bindwright/handoff.md` line in the file `git rev-parse --git-path info/exclude` prints.

**On GitHub, before the review workflows go.** When the repo has the review gate (`.github/workflows/claude-code-review.yml` among the files), say first that its branch rules still require the `Review gate` check: once the workflows are gone, no pull request can merge until that required check is removed from the branch rules (repo Settings, then Rules or Branches). Name the review secret and, with a board, the board too; this skill changes nothing on GitHub, so the user removes those by hand.

## 3. Remove the files

Run the engine with `--remove-files <repo root>`, passing on standard input `{"paths": [<every file the user agreed to remove>], "state": true}`. `state` removes `.bindwright/` last, with the saved answers, so a later `/bindwright:setup` starts fresh. It refuses a path setup did not write, one reached through a link, and one that is not a plain file, before removing anything; on `{"error": ...}`, show the message and stop. Otherwise it prints `{"removed": [...], "folders": [...], "state": true}`: the files removed and the folders that were left empty and removed with them.

When anonymous review counts are on (`node "${CLAUDE_PLUGIN_ROOT}/hooks/counts.mjs" status`), leave this repo out of them with `counts.mjs project <repo root> none`.

Nothing is committed. Say that `git status` shows the removal, and offer to commit it as one commit (`chore: remove Bindwright`), which the user can revert to get the setup back.

## 4. This computer

Run the engine with `--settings <repo root or any folder>`: `installed` lists the extras setup added to the user's config folder. Ask about each one that is there, one yes or no each, and say what it does today so the user can choose:

- **Push guard, attribution guard and the code-search hook:** `python "${CLAUDE_PLUGIN_ROOT}/engine/home.py" remove-hook <name>.py` for each, after `home.py list-hooks` shows which are installed (`push-guard.py`, `no-ai-attribution.py`, the `*-first.py` search hook). It removes the hook's entry from `~/.claude/settings.json` and its file, and keeps the user's other hooks.
- **The `git push` allow rule** setup offered with the push guard: `home.py disallow "Bash(git push:*)"`.
- **Mods:** `home.py remove-mod <name>` for each installed one. It takes the mod out of the plugin folders list and deletes its folder.
- **Builder agent:** `home.py remove-agent builder.md`.
- **Reply style:** `home.py remove-style straight-talk.md`, which also turns it off when it is the style in use.
- **Code-style profile:** delete `~/.claude/rules/code-style.md`, after showing it, since the user may want to keep it.
- **Work language:** `home.py set-language english` removes the language setting and the commit-language rule setup added.
- **Global instructions:** in `~/.claude/CLAUDE.md`, take out the sections that match `${CLAUDE_PLUGIN_ROOT}/_core/global-template/CLAUDE.md.additions` and the `<!-- bindwright:global-instructions -->` line, keeping everything else. Show the result and save it only on a yes.
- **Anonymous review counts:** `node "${CLAUDE_PLUGIN_ROOT}/hooks/counts.mjs" share off` stops every send.
- **The code-search tool** (tokensave): it is a program of its own, so it stays; give its own uninstall steps if the user asks.

Each `home.py` change backs up `~/.claude/settings.json` first, as `settings.json.bak`. Hooks, mods and agents stop at the next start of Claude Code, so say to restart it.

## 5. The plugin

Last, the plugin itself: in Claude Code, `/plugin`, then uninstall `bindwright`; from a terminal, `claude plugin uninstall bindwright@bindwright`, then `claude plugin marketplace remove bindwright` to drop its marketplace. The choices setup saved for this computer stay in `<config>/bindwright/` (`<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`), so a later install remembers them; say the user can delete that folder for a clean slate.

Tell the user, in plain words, what was removed, what stayed and why (their edits, their own files, anything they said no to), and what they still do by hand.

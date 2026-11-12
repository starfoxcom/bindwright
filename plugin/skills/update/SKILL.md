---
name: update
description: Bring a repo set up with /bindwright:setup up to today's Bindwright templates. Rebuilds the files from the saved answers and merges each one with the repo's own edits, stopping on any real clash.
disable-model-invocation: true
---

# /bindwright:update

This skill rebuilds the repo's Bindwright files from the answers saved at setup, with today's templates, and merges each one three ways: the file as the last setup or update wrote it, the repo's copy, and the new text. Edits the repo made survive; a file where both sides changed the same lines is left alone for the user to settle. Nothing is committed.

## 1. Check the repo

- Find the repo root with `git rev-parse --show-toplevel`.
- If `.bindwright/pristine.json` or `.bindwright/project.json` is missing, this repo was not set up with Bindwright: tell the user to run `/bindwright:setup` instead, and stop.
- If `git status --porcelain` shows uncommitted changes, say so and ask whether to continue. On a clean tree the update reads as one diff and is undone with `git restore`.
- If `.bindwright/incoming/` already holds files, an earlier setup or update left them unsettled. Say so; step 3 goes through them with the new ones.

## 2. Run the update

Find the helper and pick the engine as setup's step 0 does (`${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`), installing the helper on a yes when it is missing or holds another version than the plugin. With neither, tell the user the update needs Node 18 or later, or Python 3.8 or later, and stop.

First say what the releases changed: run the engine with `--releases-since <repo root>`. It reads only the plugin's own changelog, never the repo's `CHANGELOG.md`, and prints `{"from": "<bound version>", "to": "<plugin version>", "releases": [{"version", "date", "text"}, ...]}`, newest first. When `releases` holds any, open with a plain summary of each release in the range, newest first and a few short lines each: what is new, what changed and what was fixed, then anything the user may want to act on, such as a new setup answer to consider or a behaviour that now works differently. When it holds an `unavailable` reason, say in one line that the summary is not available and why, and go on.

When `advanced.localOnly` is true in `.bindwright/project.json`, first refresh the exclude list: run the engine with `--local-exclude <repo root>`, passing that file on standard input, so a file the new version adds for the assistant stays out of commits from its first write. Name any `tracked` path it prints, as setup does.

Run it with `--update <repo root>`. It prints one line of JSON:

- `{"error": "..."}`: show the message and stop; nothing was written. Unless it is the symbolic-link message below, offer `/bindwright:report`. A message starting `Refusing to write through a symbolic link` names repo files that are links: the update never writes through one. Offer to list each in `.bindwright/owned`, so later updates leave it alone, or to replace the link with a plain file, then run the update again.
- Otherwise, lists of repo paths by what happened to each file:

| List | What happened | What the user does |
|---|---|---|
| `updated` | The repo never changed the file; it now has the new text | Nothing |
| `merged` | The repo's edits and the template's changes touched different lines; both are in | Read the diff |
| `added` | New in the templates; written in place | Nothing, beyond step 4 |
| `staged` | New in the templates, but the repo already has a file there; the new text is at `.bindwright/incoming/<path>` | Merge it (step 3) |
| `conflict` | Both sides changed the same lines, or the merge would lose a kept section; the repo's copy is untouched and the merge, with all three versions at each clash, is at `.bindwright/incoming/<path>` | Settle it (step 3) |
| `renamed` | Pairs of `[old path, new path]`: the templates moved the file, so its copy, the repo's edits included, now sits at the new path (and in the list above that says how it merged), and the old file is gone | Nothing, beyond what that list asks |
| `removed` | The templates dropped a file the repo never changed | Say whether to delete it |
| `removed_edited` | The templates dropped a file the repo changed; it stays | Nothing, or delete it by hand |
| `deleted` | The repo deleted a file setup wrote; it stays deleted | Nothing |
| `owned` | Listed in `.bindwright/owned`; never touched | Nothing |
| `unchanged` | Already up to date | Nothing |
| `skipped` | A staged copy from an earlier run was already there, so the new one was not written; the file keeps its old base | Settle the old copy, then run the update again: it stages the newer text |

Edits inside `.claude/` ask the user for permission even when edits are otherwise accepted. Before the first one, say that the next steps change the repo's agent settings and rules.

## 3. Settle what was staged

Go through `.bindwright/incoming/` file by file. Delete each staged copy once its file is settled. Then run the engine with `--clean-staging <repo root>`, never `rm -rf`, which the project's settings deny: it removes the folder once no staged copy waits in it, lists the ones that still do under `unsettled`, and refuses a folder that is a link.

- **A `staged` file:** no earlier version exists to merge against, so merge it with the repo's copy the way setup's merge step does: run the engine with `--propose-merge <repo root>` (it lists every file in `.bindwright/incoming/`; use the proposals for the `staged` ones, since a `conflict` file carries its own markers), read each proposal against the repo, and show the summary, the clashes with both versions and a recommendation for each. Save only after a yes. Never replace a `LICENSE` without an explicit yes.
- **A `conflict` file:** the staged copy is the merged file, with each clash marked `<<<<<<< this repo`, `||||||| last setup or update`, `=======` and `>>>>>>> today's templates`. Everything outside the markers already merged cleanly. For each clash, show the user the three versions in plain words (what the repo has, what the templates had, what they have now) and ask which to keep, or write a mix they agree to. Then save the result over the repo's file, with no markers left. When the staged copy has no markers, the clash is a kept section (`bindwright:keep` to `bindwright:end-keep`) that the merge would change: keep the repo's section as it is, and take the rest from the staged copy only on a yes.

A settled conflict does not come back: the update already recorded today's templates as the new base, so the next one compares against them.

## 4. Fill and check the new text

Files that were `added`, or merged from new text, can hold placeholders setup fills (`{{TEST_COMMAND}}` and the rest). Search those files for `{{` and fill each placeholder the way setup's step 4 says, reading the repo first and asking only what it cannot answer. Then check that every command and path the new text names exists in the repo. Last, when the `from` that `--releases-since` printed in step 2 is an `x.y.z` version older than its `to`, search the repo's tracked files outside `.bindwright/` for it (`git grep -nF "<from>" -- ':!.bindwright'`) and list each hit that names Bindwright's version for the user to update; the update never edits the project's own docs. Skip the search for any other `from`.

## 5. Offer the removals

For each path in `removed`, say in one line what the file was for and delete it only on a yes. Mention the `removed_edited` paths: the templates no longer ship them, and the repo keeps its copy.

Then check that `.claude/settings.local.json`, the personal file that holds the allow list and this person's own switches, stays out of git. Unless `"localOnly"` is true, run `git check-ignore -q --no-index .claude/settings.local.json`; when it fails, add that path to `.gitignore`. When `git ls-files .claude/settings.local.json` prints it, say the file is committed, so everything in it is in the history, and offer `git rm --cached .claude/settings.local.json`, which stops tracking it and keeps the file on disk. Say that every other clone deletes its copy when it pulls or checks out that commit, as git does for a file a commit removes, so each person copies theirs aside first and puts it back after.

## 6. Review counts

When Node is there and `node "<helper>/hooks/counts.mjs" status` shows `"share": true` with no entry for this repo root, this repo was set up before sharing was turned on. Ask setup's "What kind of project is this?" question (`${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`, step 3) with its "leave this project out" option, and its batch question when the history check calls for it, and save the answers the same way.

## 7. Finish

Tell the user, in plain words and grouped by kind (rules, skills, hooks, workflows, docs) rather than file by file: what was updated, what merged, what they settled, what was added or removed, and anything left unsettled in `.bindwright/incoming/`.

Then say that `.bindwright/pristine.json` changed too and belongs in the commit, since the next update merges against it, and that nothing is committed: they can read the changes with `git diff` and commit when happy.

Do not commit or push.

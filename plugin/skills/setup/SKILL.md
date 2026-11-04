---
name: setup
description: Set up Bindwright in this repo. Asks a few questions in the session (the ones about this computer only the first time), then writes the rules, session skills, guard hooks and review workflows and fits them to the repo.
disable-model-invocation: true
argument-hint: "[global | bw1- setup code]"
---

# /bindwright:setup

The argument is: `$ARGUMENTS`

This skill asks the user how they want to work, writes the files that fit into the repo, fits them to it, then sets up the extras for the user's own `~/.claude`. It never overwrites a file without the user's yes, and outside the repo it changes only what the user agreed to.

Two kinds of choices, and the user always hears which is which:

- **Computer choices** apply to every project on this computer and are asked only once: the code-search tool, global instructions, the push guard for every project, the builder agent, the code-style profile, and the mods. They are saved in `<config>/bindwright/settings.json`, where `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`.
- **Project choices** apply to this repo only and are asked on every run, never copied from an earlier project, since a lot can change between two projects.

## 0. Pick the engine and read the saved choices

Pick the engine: the first of these that runs.

1. `node --version` works: the engine is `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.js"`.
2. `python3 --version` or `python --version` reports 3.8 or later: the engine is that interpreter with `"${CLAUDE_PLUGIN_ROOT}/engine/bind.py"`.

With neither, tell the user setup needs Node or Python 3.8+, and stop.

## 1. Check the argument and the repo

- **`global`:** the user wants to change their computer choices. Find the repo root as below if there is one (any folder works for the settings commands otherwise), ask every question of step 2, even those with a saved answer, saying what each is now. Save them as step 2 says, set up the extras of step 7 that just turned on, and for each one that turned off, say what stays installed and how to remove it (`python "${CLAUDE_PLUGIN_ROOT}/engine/home.py" remove-hook <name>` for a guard; delete `~/.claude/mods/<name>` and its `CLAUDE_CODE_PLUGIN_DIRS` entry for a mod; delete `~/.claude/agents/builder.md` for the builder agent; delete `~/.claude/rules/code-style.md` for the code-style profile). Then stop.
- **A code starting with `bw1-`:** a setup code from an older Bindwright page. It holds every project answer, so skip step 3 and run the engine with `--code <the code>` in step 4. Step 2 still asks the computer questions that have no saved answer.
- **Anything else that is not empty:** say this skill takes no argument, `global`, or a `bw1-` code, and stop.
- Find the repo root with `git rev-parse --show-toplevel`. If this is not a git repo, ask whether to run `git init` here or stop.
- If `git status --porcelain` shows uncommitted changes, say so and ask whether to continue. The setup is easier to review on a clean tree.
- If `.bindwright/pristine.json` already exists, this repo was set up before, with the answers in `.bindwright/project.json`. Say so and offer `/bindwright:update`, which keeps the repo current; ask whether to start over instead (delete both files first, so the new ones are written) or stop.
- Otherwise, if the repo has its own agent setup already (`CLAUDE.md`, `.claude/rules/`, `.claude/skills/`, `.claude/hooks/`, or a review workflow under `.github/workflows/`), this is **adopt mode**: say so in one line. Nothing lands without a yes, file by file.
- If `.bindwright/incoming/` or `.bindwright/global/` already exists, an earlier setup stopped before it finished. Ask whether to finish its merges first (steps 5 and 7 on those files) or delete both folders and start fresh.

## 2. Computer choices, asked once

Run the engine with `--settings <repo root>`. It prints `{"settings": {...}, "extras": {...}, "installed": {...}}`; an entry whose `from` is `"personal"` is a choice this person already made for the computer. Ask only the questions below that have no such entry. The first time on a computer that is all of them; later, usually none.

Before asking, say in one line: "These are about your whole computer, so I'll only ask them once."

Ask with the question tool, recommended option first:

- **Code-search tool** (setting `codeResearch`): how the assistant finds code. Offer `tokensave` (recommended), `none` and `custom`. Say in one or two plain lines why: `tokensave` indexes the code, so the assistant answers code questions about a quarter faster on a large codebase, for a few percent more tokens; `none` uses the built-in search, which in our tests was just as accurate and the cheapest, only slower; `custom` is for a tool they already use. The `tokensave` entry's install and wiring steps come from `${CLAUDE_PLUGIN_ROOT}/_core/global-template/hooks/code-research-profiles.json`.
- **Global instructions** (extra `global-instructions`): a short set of working rules every project on this computer reads. Yes (recommended) or no.
- **Push guard for every project** (extra `push-guard`): blocks force pushes in every repo on this computer, including ones Bindwright never set up. Yes (recommended) or no. Each Bindwright project also gets its own copy in the repo, so this only adds the others.
- **Builder agent** (extra `builder`): a helper that runs on the small, cheap Haiku model and writes the code for a short brief the main session gives it, while the main session designs, runs the tests, reads the diff and commits. It costs a fraction of the main model doing the same work. Yes (recommended) or no; say that "no" keeps all work in the main session.
- **Code-style profile** (extra `code-style`): with their permission, read the code they wrote by hand, in their local repos and their GitHub account, and save a short profile of how they write code, with the weak spots brought up to current practice, which every session then follows. Yes (recommended) or no; say it takes a few minutes and can run later with `/bindwright:code-style`.
- **Mods** (one extra per mod): small add-ons for the CLI, which need CLI 2.1.287 or later and Node. Take the version this session runs from the `AI_AGENT` environment variable (`claude-code_2-1-316_agent` is 2.1.316), not from `claude --version`: the desktop app runs its own copy of the CLI, which can be older than the one on the PATH. Only when `AI_AGENT` is unset, use `claude --version`. When the version is older or Node is missing, skip this question and say why in one line, saving nothing for the mods, so a later run asks again. Otherwise ask one multiple-choice question listing only the mods with no saved answer, from the table in `${CLAUDE_PLUGIN_ROOT}/_core/global-template/mods/README.md`, one line each, `session-facts` and `compact-handoff` first and marked recommended. Every mod listed and not picked is saved as a no.

Save the answers in one call: the engine with `--remember <repo root> --layer personal`, passing on standard input `{"codeResearch": "<tool>", "extras": {"global-instructions": true, "push-guard": true, "builder": true, "code-style": true, "session-facts": true, "ci-watch": false, ...}}` with only the keys just asked. On `{"error": ...}`, show it and go on: the choices still apply to this run.

## 3. Project choices, asked every run

Say in one line: "Now a few about this project only."

Read what the repo can answer first: the project name is the repo folder's name, the repo URL comes from `git remote get-url origin` (written as `https://github.com/<owner>/<repo>` for a GitHub remote, otherwise empty), and the license holder is `git config user.name`.

Ask with the question tool, in two rounds. Round one:

- **Who works on it?** Just me, or a team.
- **Whose project is it?** Mine, or someone else's (a client or an employer).
- **Private or public?** Private, or public. Recommend private for someone else's project, public otherwise.
- **AI credit in commits?** Keep it out (recommended): commits, PRs and comments carry no "generated with" lines or AI co-author credit. Or allow it.

Round two, each with "All of them (recommended)" first and "Let me pick" second:

- **Checks on every change:** an AI review on every pull request, a deeper review when a change is risky, and a check that fails when code grows past the size limits.
- **How the assistant works here:** writing in plain language, and changes to anything people see made in small steps checked one at a time.

For a "Let me pick", ask one multiple-choice question with that group's items; what is not picked is off. A deeper review needs the AI review: if only the deeper review is picked, say it needs the AI review and turn both on.

### Where the work state lives

GitHub works here when the repo's remote is on GitHub and `gh auth status` works. When it does not, say why in one line and use the detailed hand-off file (`"tracker": "file"`). Otherwise ask:

- **Where should the plan and the work state live?**
  - A GitHub board with the issues, plus a short hand-off note between sessions (recommended): `"tracker": "github"`, `"handoffFile": true`, and a board as below.
  - GitHub issues only, with the project's status in a pinned issue: `"tracker": "github"`, `"handoffFile": true`, no board.
  - A detailed hand-off file and a roadmap in the repo, no GitHub: `"tracker": "file"`.

**Public code.** With either GitHub choice, read the repo's visibility (`gh repo view --json visibility -q .visibility`). When it is `PUBLIC`, its issues are public too, whatever the board's setting, so ask:

- **Your code is public, so its issues are public too. Keep the full-detail work items in a private repo of their own?**
  - Yes, a private repo for the work items (recommended): suggest `<owner>/<repo>-tracker`, create it on a yes with `gh repo create <owner>/<name> --private`, and put `"trackerRepo": "<owner>/<name>"` in the answers. The board, when there is one, links that repo instead of this one.
  - No, keep the issues in this public repo: say they are then readable by anyone, so they should be written for outsiders, with no engineering data.

**The board.** Board commands need the `project` scope: when `gh project list --owner <owner>` fails on it, ask the user to run `! gh auth refresh -s project` and wait. If the user named a board of their own (`<owner>/<number>`), use it. Otherwise, on a yes, create one named after the repo with `gh project create --owner <owner> --title "<repo name>" --format json` and link it with `gh project link <number> --owner <owner> --repo <the repo that holds the issues>`. Put `"trackerProject": "<owner>/<number>"` in the answers.

Then read its visibility (`gh project view <number> --owner <owner> --format json --jq .public`) and ask:

- **The board is private, and it holds the project's full engineering details: numbers, file names, dead ends. Keep it that way?**
  - Keep it private (recommended).
  - Keep it private, and add a clean public copy for outsiders: only a short summary per item, with no engineering data.
  - Make this board public, details and all.

**A clean public copy** goes in its own public repo, which must start with no issues, pull requests or discussions, since the copy keeps the same item numbers. Suggest `<owner>/<repo>-roadmap`, create it on a yes with `gh repo create <owner>/<name> --public`, and put `"publicRoadmap": "<owner>/<name>"` in the answers. Say that an item goes public only once its issue has a `### Public summary` section, and that `tracker.md` explains how the copy is written and checked.

**Making the full board public** gets a warning first, in these words or close to them, set apart so it cannot be skimmed:

> ⚠️ **This publishes the project's engineering record.** Everyone, including AI crawlers and anyone building a copy of the product, could read the board's fields, status updates and every note on its items: measurements, file and function names, tuning values, dead ends, what is planned next. Once public, it can be scraped and cached within hours, and making it private again does not take back what was copied. The safer way is the clean public copy: outsiders see what is planned and done, and the details stay private.

Then ask once more: keep it private (recommended), add the clean public copy instead, or make it public anyway. On "make it public anyway", run `gh project edit <number> --owner <owner> --visibility PUBLIC` and say once that the session checks warn about it from now on. It is the user's call; do not ask a third time.

## 4. Write the files

Build the answers. Only what differs from the defaults is needed; every other choice keeps its default.

```json
{
  "team": false,
  "client": false,
  "private": false,
  "project": { "name": "<folder name>", "repoUrl": "<url or empty>", "licenseHolder": "<git user name>" },
  "advanced": {
    "attributionGuard": true,
    "aiReview": true,
    "deepEscalation": true,
    "codeSizeCheck": true,
    "plainWriting": true,
    "uiRule": true,
    "handoffFile": true,
    "codeResearch": "<the computer's code-search tool>",
    "tracker": "github",
    "trackerProject": "<owner>/<number> or null",
    "trackerRepo": "<owner>/<name> or null",
    "publicRoadmap": "<owner>/<name> or null"
  }
}
```

Run the engine with `--write <repo root>`, passing the answers on standard input (or `--code <the code>` for a `bw1-` code), and add `--adopt` in adopt mode: it then stages every file, new ones included, instead of writing them in place. It prints one line of JSON:

- `{"error": "..."}`: show the message and stop. A message starting `Invalid setup code` means the code was cut or changed while copying; ask for a fresh copy. A message starting `Invalid answers` names the answer it refused: fix that answer and run again. For any other error, offer `/bindwright:report`.
- `{"written": [...], "staged": [...], "skipped": [...]}`: paths relative to the repo root.
  - `written`: new files, now in place.
  - `staged`: files the repo already had. The repo's copy is untouched; the new text is at `.bindwright/incoming/<path>`.
  - `skipped`: files whose staged copy already existed from an earlier run. Nothing was written for them.

Edits inside `.claude/` ask the user for permission even when edits are otherwise accepted. Before the first one, say that the next steps change the repo's agent settings and rules.

Fill `{{STACK_COMMANDS_ALLOWLIST}}` in `.claude/settings.local.json` now (see step 6). Until it is filled, that file is not valid JSON.

## 5. Merge what was staged

Every file under `.bindwright/incoming/` is new text for the file at the same path without that prefix. The engine always stages files a repo often has (`CLAUDE.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`, `.gitattributes`, `.claude/settings.json`), plus every file reported as `staged`.

For each one:

- **The repo has no file at that path:** move the staged copy into place.
- **The files are identical:** delete the staged copy.
- **Both exist and differ:** merge them. Keep everything the repo's copy says that the new text does not contradict, add what the new text brings, and where the two disagree, show both versions and ask which wins. Show the user a short summary of each merge and save it only after a yes.
  - `.claude/settings.json`: merge as JSON. Union the permission lists, append hooks the repo does not have, keep the repo's value for any other key both set.
  - `LICENSE`: never replace an existing license without an explicit yes; a license change is a legal decision.
  - `CLAUDE.md`: keep the repo's project-specific sections, and put the new rules where they read naturally rather than appending a second copy of a section.
- Delete the staged copy once its file is settled.

In adopt mode, offer every staged file without a repo copy on its own: one line on what it does, move it into place on a yes, delete the staged copy on a no. For a file both have, go through the differences one at a time rather than merging the whole file at once.

Then offer the two ways to mark parts of the repo as the project's own, which a later update never changes. In adopt mode, suggest them for whatever the user kept over the new text.

- **Whole files:** `.bindwright/owned`, one repo path or pattern per line (`*` within a folder, `**` across folders, a trailing `/` for a whole folder, `#` for comments), for example the project's own review workflow.
- **Sections of shared files:** a line holding `bindwright:keep` and a later one holding `bindwright:end-keep`, written in the file's own comment style (`<!-- bindwright:keep -->` in Markdown, `# bindwright:keep` in YAML or Python). Markers do not nest.

Remove `.bindwright/incoming/` when it is empty. Mention any `skipped` paths: their staged copies came from an earlier run, and the user decides whether to merge or delete them.

## 6. Fill what the questions did not ask

Search the repo's new and merged files for these placeholders and replace each one. Read the repo first; ask the user only what the repo cannot answer, all in one question.

| Placeholder | Where to find it |
|---|---|
| `{{ONE_LINE_DESCRIPTION}}` | The README's opening or the package manifest's description |
| `{{LANGUAGE_AND_FRAMEWORK}}` | Manifests and lockfiles (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`, `project.godot`, ...) |
| `{{LINT_COMMAND}}`, `{{TYPECHECK_COMMAND}}`, `{{TEST_COMMAND}}` | Package scripts, Makefile targets, tool config and the CI workflows. Run each once when it is quick, to check it works |
| `{{CONVERSATION_LANGUAGE}}` | The language the user writes to you in |
| `{{CODE_LANGUAGE}}` | The language of the existing code comments and docs; English for a new repo |
| `{{STACK_COMMANDS_ALLOWLIST}}` | The commands above as permission entries, each written `,` then a new line and `"Bash(<command>:*)"`, matching the list it sits in; nothing when there are none. Never add a rule for `git push` or a bare `git`: either would approve force pushes. When a command runs other commands (`npm run`, `npx`, `make`, `uv`, `poetry`, `bundle exec`, `docker run`), tell the user its rule approves whatever runs through it |
| `{{TEAM_OR_USER}}`, `{{LEAD_USER}}` | The GitHub team or user who owns the repo (from `git remote get-url origin`, or ask) |

When the project has no such command (no type checker, no tests yet), remove that part of the sentence or the hook entry instead of inventing a command, and tell the user what was left out.

Then fit the rules to the repo:

- `.claude/rules/code-size.md`: keep only the per-language rows for languages the repo contains (count files by extension, ignoring vendored and generated folders), plus `Other` when the repo has languages the table does not list. Narrow its `paths:` globs to the same languages.
- **Size check:** when `.github/scripts/size_check.py` was written, record the breaches the repo already has, after trimming the code-size rule above. It needs lizard, the version the workflow pins: show `python -m pip install --user lizard==1.24.3` (or a virtual environment the user prefers) and run it only on a yes. The script measures only files git tracks, and nothing setup wrote is committed yet, so first run `git add -N` on every file the repo will keep (the written and merged ones; it stages no content). Then run `python .github/scripts/size_check.py --write-baseline` and say how many breaches it recorded in `.github/size-check/baseline.txt`, which belongs in the commit. Without lizard, leave the baseline out and tell the user the check fails until they write it. Mention that the `Size check` job can be made a required check in the branch rules.
- `.gitignore`: `.claude/settings.local.json` is personal. If `git check-ignore -q .claude/settings.local.json` fails, add that path to `.gitignore` (create the file if needed).
- **Tracker:** when `.claude/rules/tracker.md` was written, the work state lives in GitHub issues. With a board (`advanced.trackerProject` in `.bindwright/project.json`), check `gh project view <number> --owner <owner>` reaches it; a scope error means `gh auth refresh -s project`. Without one, offer to create and pin the `Project status` issue that `tracker.md` describes. With a public roadmap (`advanced.publicRoadmap`), check `gh api "repos/<public repo>/issues?state=all&per_page=1"` reaches it and returns `[]`: the tool keeps public numbers equal to private ones, so the public repo must start with no issues, pull requests or discussions, which share the numbers; check discussions on the repo's page. Then offer to turn any `ROADMAP.md` items or hand-off file the repo already has into issues, one at a time, with the "New item" command in `tracker.md`; the old files stay until the user removes them.
- `.claude/rules/git.md` names the branches work lands on. If it names a development branch the repo does not have (`git branch --list <name>`), offer to create it from the current branch, locally only.
- Check that every command and path the new files name exists in the repo. Fix what you can; list the rest for the user.

## 7. Set up the computer choices

`.bindwright/global/` holds files for the user's own `~/.claude`, which every project on this computer shares. When it is not there (the `global` path, or `/bindwright:join`), render it: pipe the repo's `.bindwright/project.json` into the engine without `--write` (outside a set-up repo, `{"team": false, "client": false, "advanced": {"codeResearch": "<tool>"}}`), write each `files` entry whose path starts with `.bindwright/global/` into a temporary folder, use that folder below, and delete it at the end. Set up each computer choice the user said yes to, now or on an earlier run, and skip what is already in place (`installed` from step 2). Nothing here is asked again, except a change of an existing file, which is shown first. Changes go through `python "${CLAUDE_PLUGIN_ROOT}/engine/home.py" <command>` (any Python 3.8+ can run it). It backs up `~/.claude/settings.json` before each change, refuses a settings file that is not valid JSON, and prints one line of JSON; on `{"error": ...}`, show the message and skip that extra.

The hooks need a system Python: run `home.py find-python` once. On an error, skip every hook below, and tell the user why and that a later run can add them.

- **Global instructions:** merge `CLAUDE.md.additions` into `~/.claude/CLAUDE.md`, everything from its first `---` line on. Create the file when it is missing. Never add a section the file already has; where the two differ, show both and ask. Then add the line `<!-- bindwright:global-instructions -->` on its own at the end, if the file does not hold it yet: it is how `installed` knows the sections are there, since many people already have a `CLAUDE.md` of their own.
- **Project memory** (always, no question): copy `memory/MEMORY.md` to `~/.claude/projects/<folder>/memory/MEMORY.md`, only when no index is there yet. `<folder>` is this repo's folder under `~/.claude/projects/`: the CLI names it after the repo's full path, with every character other than a letter or digit turned into `-`.
- **Code-search tool:** `${CLAUDE_PLUGIN_ROOT}/_core/global-template/hooks/code-research-profiles.json` has the chosen tool's install command per system, the step that wires it into the agent, and its indexing step. The install and wiring happen once per computer: skip them when the tool already runs. The indexing step belongs to each project: run it here. Show each command, run it only on a yes, and stop at the first failure.
- **Code-search hook:** when `hooks/` holds a `*-first.py` and `home.py list-hooks` does not show it yet, install it with `home.py install-hook <that file> --python <found> --matcher "Grep|Glob|Bash"`. If `~/.claude/hooks/` already has a different copy, show the difference first. Offer to remove any other `*-first.py` with `home.py remove-hook <name>`, since two of them would fight over every search. Say that the hook blocks searches only while the tool is available.
- **Attribution guard in `~/.claude`:** only when `hooks/` holds `no-ai-attribution.py`, which happens when the project keeps its guards in each person's `~/.claude` instead of the repo. Install it with `--matcher "Bash|PowerShell"`, then run `home.py attribution-off`, which stops the CLI adding its own credit lines. Save `{"extras": {"attribution-guard": true}}` with `--remember <repo root> --layer personal`.
- **Push guard:** `home.py install-hook hooks/push-guard.py --python <found> --matcher "Bash|PowerShell"`. It only ever blocks, so it needs no other change. The first time it goes in, ask separately: "Let every `git push` run without a prompt in every project on this computer? The guard blocks force pushes written the ordinary way; it cannot see one built at run time, set in git config, or run by another program." On a yes, `home.py allow "Bash(git push:*)"`.
- **Builder agent:** `home.py add-agent agents/builder.md`. A copy already in `~/.claude/agents/` stays (`"kept_existing": true`), since it may hold the user's edits. Agents load at start-up, so the user restarts the CLI after.
- **Code-style profile:** ask whether to build it now or later. Now: follow `${CLAUDE_PLUGIN_ROOT}/skills/code-style/SKILL.md` from its step 1, then come back here. Later: say to run `/bindwright:code-style` when they have a few minutes; a later setup run asks again until the profile exists.
- **Mods:** install each chosen one with `home.py add-mod "${CLAUDE_PLUGIN_ROOT}/_core/global-template/mods/<name>"`. A mod already installed keeps its copy (`"kept_existing": true`), since it may hold the user's edits. Mods load at start-up, so the user restarts the CLI after. The CLI's built-in "You should know" mod stays off: say in one line that it reviews each session with an extra model call and needs telemetry, and that the user can turn it on later.

After a hook install, check it works: pipe `{"tool_name": "Bash", "tool_input": {"command": "git push -qf origin main"}}` into the registered command and arguments on standard input, writing no file (`home.py` printed the settings path; the entry is the last one under `hooks.PreToolUse`). The push guard must exit 2.

Delete `.bindwright/global/`.

## 8. Finish

Tell the user, in plain words, in two parts.

**This project:**

- What was written, merged and left out, grouped by kind (rules, skills, hooks, workflows, docs), not file by file.
- Where the work state lives: the board's link and whether it is private, the clean public copy's repo when there is one, or the hand-off file.
- What still needs them: for a repo with AI review workflows, the repository secret and branch rules those workflows describe.
- That `.bindwright/project.json` (their answers) and `.bindwright/pristine.json` (the files as generated, before any merge or fill) belong in the commit and are not edited by hand: later updates merge against them, so the repo's own edits survive.
- That nothing is committed yet: they can read the changes with `git diff` and `git status`, and commit when happy.

**This computer:**

- Each computer choice and its answer, one line each (code-search tool, global instructions, push guard, builder agent, code-style profile, mods), and what was installed this run.
- Where they live and how to change them: `/bindwright:setup global` asks them again, or edit `<config>/bindwright/settings.json` (name the real path). The next project on this computer will not ask them.
- That `~/.claude/settings.json.bak` holds the settings from before the last change, when one was made.

Do not commit or push. Outside the repo, change only what the user said yes to.

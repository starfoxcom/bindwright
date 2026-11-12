---
name: setup
description: Set up Bindwright on this computer and in this repo. The first run asks the computer choices, then offers the project setup, which writes the rules, session skills, guard hooks and review workflows, fits them to the repo and picks the mods it runs.
disable-model-invocation: true
argument-hint: "[global | project | bw1- setup code]"
---

# /bindwright:setup

The argument is: `$ARGUMENTS`

This skill asks the user how they want to work, writes the files that fit into the repo, fits them to it, then sets up the extras for the user's own `~/.claude`. It never overwrites a file without the user's yes, and outside the repo it changes only what the user agreed to.

Two kinds of choices, and the user always hears which is which:

- **Computer choices** apply to every project on this computer and are asked only once: the code-search tool, the work language, global instructions, the push guard for every project, session titles, the builder agent, the code-style profile, the reply style, and the mods. They are saved in `<config>/bindwright/settings.json`, where `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`.
- **Project choices** apply to this repo only and are asked on every run, never copied from an earlier project, since a lot can change between two projects. They include which per-project mods run here: a mod turned off in one project stays on in every other.

## 0. Pick the engine and read the saved choices

Check all three tools before saying anything: `git --version`, `node --version` (18 or later counts) and `python3 --version` or `python --version` (3.8 or later counts; a `python` that only opens the Microsoft Store does not). Setup needs Git, and Node or Python to run its engine: one of the two is enough.

When Git is missing, or neither Node 18 or later nor Python 3.8 or later is there, name what is missing (Git, an engine, or both) in one plain message: Git keeps the project's history, so every change can be seen and undone, and the files setup writes work through it; Node or Python runs the setup itself. Then give the install for the user's system:

- **Windows:** offer to run it on a yes: `winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements`, and the same form with `Python.Python.3.12` when Python is not there (it runs the engine, the hooks and the computer extras) and with `OpenJS.NodeJS.LTS` when neither engine is there.
- **macOS:** offer to run it on a yes: `xcode-select --install`. It opens the system's own installer and brings both Git and Python, which is enough for the engine.
- **Linux:** give the command for the user to run in their own terminal, since it asks for their password: `sudo apt install -y git python3` (`sudo dnf install -y git python3` on Fedora). The distributions' own `nodejs` package can be too old for the engine.

Then say to restart Claude Code, since a running session does not see a program installed after it started (quit and reopen the desktop app or the editor it runs in, such as VS Code or JetBrains, or start `claude` again in a new terminal window), and to run `/bindwright:setup` again. Stop here.

With Git and at least one of Node 18 or later or Python 3.8 or later in place, find the helper: the part of Bindwright that runs on this computer (the engine, the templates and its scripts), which ships apart from the plugin, as files attached to the plugin's release on GitHub. It lives in one folder, written `<helper>` in every Bindwright skill, and the engine runs from it. Take the first of these that runs:

1. Node 18 or later: `<helper>` is `$HOME/.bindwright/helper/node_modules/bindwright`, and the engine is `node "<helper>/engine/cli.js"`.
2. Python 3.8 or later: `<helper>` is `$HOME/.bindwright/helper/python/bindwright`, and the engine is that interpreter with `"<helper>/engine/bind.py"`.

The helper is ready when `<helper>/VERSION` holds the same version as the plugin, the `version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` (compare them without a leading `v`). When it is missing or holds another version, ask: "Bindwright needs its helper, the part that writes your files, installed for your user only, with no admin rights. Install it now?", with "Yes" first (say "update it to <version>" when an older one is there). On a yes, install exactly the file `${CLAUDE_PLUGIN_ROOT}/helper.json` names for the engine picked above (its `node` or `python` entry), which the plugin pins by its SHA-256:

1. Download its `url` into `$HOME/.bindwright/helper/` (create the folder first) under its `file` name: `curl -fsSL -o "$HOME/.bindwright/helper/<file>" "<url>"`, typed `curl.exe` in Windows PowerShell, where `curl` names another command.
2. Check that the download's SHA-256 is the entry's `sha256`: `sha256sum` on Linux and in Git Bash, `shasum -a 256` on macOS, `Get-FileHash -Algorithm SHA256` in PowerShell. When it differs, delete the file, say the download does not match the plugin, and stop.
3. Install from that file, with no install scripts, then delete the file:
   - Node: `npm install --prefix "$HOME/.bindwright/helper" --no-save --ignore-scripts --no-audit --no-fund "$HOME/.bindwright/helper/<file>"`
   - Python: `<python> -m pip install --upgrade --no-deps --no-index --target "$HOME/.bindwright/helper/python" "$HOME/.bindwright/helper/<file>"`. It works on a Python the system or Homebrew manages, since it installs into its own folder. When `pip` itself is missing, say how to add it (`sudo apt install python3-pip` on Debian and Ubuntu, for the user to run) and stop.

Then read `<helper>/VERSION` again. On a no, or when the install fails, stop: setup writes nothing without it. Show the install's last lines, and when it could not reach the network, say to run setup again once online.

**Git for Windows.** On Windows, the project's guard hooks run in Git for Windows' own shell, and the CLI blocks every shell command when that shell is missing. `git --version` printing `.windows.` (as in `git version 2.47.0.windows.1`) means it is there. When it is not, treat Git as missing above and offer the same `winget` install.

**Lizard, for the size check.** Skip this with the `global` argument and in a first run's computer part (step 1); a first run that goes on to the project asks it then, before step 3. With Python there, check `<python> -m lizard --version`, and when that fails, the copy step 6 may have installed in setup's own environment: `~/.bindwright/size-check-venv/bin/python -m lizard --version` (`Scripts\python.exe` in place of `bin/python` on Windows). When both are missing, ask now, with the other requirements, so nothing stops for it later: "The size check, which keeps files and functions under the size limits, needs a small Python tool called lizard. Install it when setup writes the size check?" Offer "Yes" first. Step 6 installs it on a yes, and only when the size check is written, so a run that leaves the check out installs nothing. Without Python, skip the question; step 6 says the size check needs Python.

**Plain mode.** When `git config user.name` prints nothing or `gh auth status` fails, ask first: "Have you used Git and GitHub before?", with "Not really" first. On "Not really", word every later question and message in everyday words, with no term such as branch, pull request, CI, remote or repo left unexplained; recommend the safe answers (just me, mine, private, AI credit kept out); and offer "Just this computer" first where step 3 asks where the code lives. With both commands working, skip the question.

**Git identity.** Git signs every commit with a name and an email, and refuses to commit without them. When `git config user.name` or `git config user.email` prints nothing, ask only for the one that is missing (for the email, any address the user is happy to have in the history), say it is set for every project on this computer, and on a yes set it with `git config --global user.name "<name>"` or `git config --global user.email "<email>"`. Never change one that is already set. Without them, say that the first commit will fail until they are set, and how.

## 1. Check the argument and the repo

- **No argument:** when `<config>/bindwright/settings.json` does not exist, no computer choice was ever saved here: this is a **first run**, and it starts with the computer part only. Ask step 2's questions and save them (its commands take the repo root inside a repo, and the current folder outside one), set up step 7's computer choices and tell the user the "This computer" part of step 8. Leave out step 7's two project parts, the project memory and the code-search tool's indexing step: the project part runs them. Then say, in plain words, that the computer is ready and a project setup is still to do: it fits the rules, reviews, checks and the per-project mods to each project, and that is where most of what Bindwright does lives. Inside a git repo, offer to set up this project now, "Yes" first: on a yes, go on as `project` (the computer questions are saved, so step 2 asks none); on a no, say to run `/bindwright:setup project` in each project, and stop. Outside a repo, say the same and stop. When the computer choices are saved already, a run with no argument is a `project` run.
- **`project`:** set up this repo: the checks below, then steps 2 to 8. Step 2 asks only the computer questions with no saved answer, often none.
- **`global`:** the user wants to change their computer choices. Find the repo root as below if there is one (any folder works for the settings commands otherwise), ask every question of step 2, even those with a saved answer, saying what each is now. Save them as step 2 says, set up the extras of step 7 that just turned on and a work language that changed, and for each one that turned off, say what stays installed and how to remove it (`python "<helper>/engine/home.py" remove-hook <name>` for a guard; `home.py remove-hook session-title.py` and `home.py disallow "Edit(~/.bindwright/session-titles/**)"` for session titles, whose files in `~/.bindwright/session-titles/` can be deleted too; delete `~/.claude/mods/<name>` and its `CLAUDE_CODE_PLUGIN_DIRS` entry for a mod; delete `~/.claude/agents/builder.md` for the builder agent; delete `~/.claude/rules/code-style.md` for the code-style profile; `/output-style default` for the reply style, whose file in `~/.claude/output-styles/` can stay; `counts.mjs share off` for the counts, which stops every send). When sharing just turned on and the repo root holds `.bindwright/pristine.json` with no entry in `counts.mjs status`, ask this repo's kind as step 3 says; other set-up repos are asked at their next `/bindwright:update`. Then stop.
- **A code starting with `bw1-`:** a setup code from an older Bindwright page. It holds every project answer, so skip step 3 and run the engine with `--code <the code>` in step 4. Step 2 still asks the computer questions that have no saved answer, and step 3's § "Mods in this project" is still asked, since the code holds no mod answers.
- **Anything else that is not empty:** say this skill takes no argument, `global`, `project`, or a `bw1-` code, and stop.
- Find the repo root with `git rev-parse --show-toplevel`. If this is not a git repo, ask whether to run `git init` here or stop.
- If `git status --porcelain` shows uncommitted changes, say so and ask whether to continue. The setup is easier to review on a clean tree.
- If `.bindwright/pristine.json` already exists, this repo was set up before, with the answers in `.bindwright/project.json`. Say so and offer `/bindwright:update`, which keeps the repo current; ask whether to change only this project's mods instead (§ Mods in this project, then stop), start over (delete both files first, so the new ones are written) or stop.
- Otherwise, if the repo has its own agent setup already (`CLAUDE.md`, `.claude/rules/`, `.claude/skills/`, `.claude/hooks/`, or a review workflow under `.github/workflows/`), this is **adopt mode**: say so in one line. Nothing lands without a yes, file by file.
- If `.bindwright/incoming/` or `.bindwright/global/` already exists, an earlier setup stopped before it finished. Ask whether to finish its merges first (steps 5 and 7 on those files) or remove both folders and start fresh. To remove them, run the engine with `--clean-staging <repo root> --discard-incoming`, never `rm -rf`, which the project's settings deny: it removes only those two folders and refuses a folder that is a link.

## 2. Computer choices, asked once

Run the engine with `--settings <repo root>`. It prints `{"settings": {...}, "extras": {...}, "installed": {...}}`; an entry whose `from` is `"personal"` is a choice this person already made for the computer. Ask only the questions below that have no such entry. The first time on a computer that is all of them; later, usually none.

Before asking, say in one line: "These are about your whole computer, so I'll only ask them once."

Ask with the question tool, recommended option first:

- **Code-search tool** (setting `codeResearch`): how the assistant finds code. Offer `findwright` (recommended), `none` and `custom`. Say in one or two plain lines why: `findwright` indexes every file the project tracks, code, docs and config alike, and answers plain-English questions, names and regex searches from it, with short answers; it ships with Bindwright and needs Node 22.13 or later, so offer it only when `node --version` shows that, and it is registered for every repo on this computer, so a repo searched with it gets a `.findwright/` folder that keeps itself out of git; `none` uses the built-in search, slower and with no index; `custom` is for a tool they already use. The `findwright` entry's wiring step comes from `<helper>/_core/global-template/hooks/code-research-profiles.json`. Run that step only when `node --version` shows 22.13 or later and `$HOME/.bindwright/helper/node_modules/bindwright/findwright/server.mjs` exists (the Python helper has no FindWright), also when the project's shared settings already chose `findwright` and the question was never asked; otherwise skip it and say that this computer uses the built-in search until Node 22.13 or later is installed and setup runs again. When the computer has tokensave set up from an earlier setup, say that FindWright replaces it, and offer to take it out of the agent: hooks first, so no hook keeps sending searches to tools that are gone. A `tokensave-first.py` that `home.py list-hooks` shows comes out with `home.py remove-hook tokensave-first.py`; the hooks tokensave's own installer added come out the way tokensave's README says. Then its server, with `claude mcp remove tokensave`; leave its program installed unless the user asks. A personal settings file that still names `tokensave` shows it under `ignored`: treat the code-search question as unanswered and ask it.
- **Work language** (setting `language`): the language they work in. Offer English and Spanish (Español), the one they are writing to you in first and marked recommended. Say in one line what it changes: the assistant replies in it, and writes commit messages and code comments in it unless a project's own rules name a language; the setup's own files stay in English, since the assistant reads them, not the user. Save `english` or `spanish`; for any other answer, say only those two are offered so far and ask again.
- **Global instructions** (extra `global-instructions`): a short set of working rules every project on this computer reads. Yes (recommended) or no.
- **Push guard for every project** (extra `push-guard`): blocks force pushes in every repo on this computer, including ones Bindwright never set up. Yes (recommended) or no. Each Bindwright project also gets its own copy in the repo, so this only adds the others.
- **Session titles** (extra `session-title`): every session on this computer is named after its project (the folder name, or the name setup saved), then `<Project> - <purpose>` once the session's focus is clear, instead of a name the CLI makes up from the first message. The assistant writes each session's purpose to `~/.bindwright/session-titles/`, which setup lets it do without a prompt. Several open sessions, the phone and the desktop app's session lists then tell projects and tasks apart. Yes (recommended) or no.
- **Builder agent** (extra `builder`): a helper that runs on the small, cheap Haiku model and writes the code for a short brief the main session gives it, while the main session designs, runs the tests, reads the diff and commits. It costs a fraction of the main model doing the same work. Yes (recommended) or no; say that "no" keeps all work in the main session.
- **Code-style profile** (extra `code-style`): with their permission, read the code they wrote by hand, in their local repos and their GitHub account, and save a short profile of how they write code, with the weak spots brought up to current practice, which every session then follows. Yes (recommended) or no; say it takes a few minutes and can run later with `/bindwright:code-style`.
- **Reply style** (extra `reply-style`): the assistant's chat replies come short and plain, answer first, in the user's own words, with every detail that matters kept. It changes chat only, never commits, code or docs. Yes (recommended) or no; say `/output-style default` turns it off at any time. When `~/.claude/settings.json` already sets an `outputStyle`, name it and say a yes replaces it.
- **Mods** (one extra per mod): small add-ons for the CLI, which need CLI 2.1.287 or later and Node. Take the version this session runs from the `AI_AGENT` environment variable (`claude-code_2-1-316_agent` is 2.1.316), not from `claude --version`: the desktop app runs its own copy of the CLI, which can be older than the one on the PATH. Only when `AI_AGENT` is unset, use `claude --version`. When the version is older or Node is missing, skip this question and say why in one line, saving nothing for the mods, so a later run asks again. Otherwise ask one multiple-choice question listing only the mods with no saved answer, from the table in `<helper>/_core/global-template/mods/README.md`, one line each, the recommended ones first and marked recommended (every mod but `runners` and `shared-pc`, which fit only a machine with local CI runners or several sessions at once; say `/bindwright:runners` sets up runners and recommends how many). Every mod listed and not picked is saved as a no.

- **Anonymous review counts** (needs Node; asked when `node "<helper>/hooks/counts.mjs" status` prints `"asked": false`): once a day, each set-up project on this computer whose kind they pick sends six numbers about the user's own merged pull requests (how many the AI review checked, how many it caught a problem in, how many went to a deeper review, how many it held back 3 or more rounds, how many merged, and the red review rounds summed over them) and the start and end time of the span they cover, so the Bindwright page can show results from real projects. A project goes in under a random id and a kind the user picks; no names, code, usernames or repo links leave the computer. The counter also keeps the country Cloudflare reads from the connection, and publishes only how many projects each country has. Offer "No" first and "Yes" second, neither marked recommended: it stays off unless they say yes.

Save the answers in one call: the engine with `--remember <repo root> --layer personal`, passing on standard input `{"codeResearch": "<tool>", "language": "<language>", "extras": {"global-instructions": true, "push-guard": true, "session-title": true, "builder": true, "code-style": true, "reply-style": true, "session-facts": true, "ci-watch": false, ...}}` with only the keys just asked. On `{"error": ...}`, show it and go on: the choices still apply to this run. Save the counts answer on its own with `node "<helper>/hooks/counts.mjs" share on` (or `share off`).

## 3. Project choices, asked every run

Say in one line: "Now a few about this project only."

Read what the repo can answer first: the project name is the repo folder's name, the repo URL comes from `git remote get-url origin` (written as `https://github.com/<owner>/<repo>` for a GitHub remote, otherwise empty), and the license holder is `git config user.name`.

Ask with the question tool, in two rounds. Round one:

- **Where does the code live?** GitHub; GitHub, but the organization, job or client blocks apps, Actions and boards; just this computer; or another site (GitLab, Bitbucket and the like). Recommend GitHub when the remote is on GitHub, and just this computer in plain mode or when there is no remote. When the remote is on GitHub but `gh auth status` fails for someone who knows Git, ask in one line whether their organization blocks the GitHub CLI and apps; on a yes, recommend the blocked answer below. GitHub with apps, Actions and boards blocked saves `"codeHost": "github"` and `"githubApps": false`: setup keeps branches, pull requests and issues and writes no workflow, review gate or board, plus `.claude/rules/code-host.md`, which says what was left out and that the checks run on this computer before each push. Round two offers only the size check (which then runs by hand; the local review below is a question of its own) and saves `"aiReview": false` and `"deepEscalation": false`, and "Where the work state lives" offers only GitHub issues without a board and the hand-off file. Just this computer needs no account: the project's history stays in this folder, so say to keep a backup of it. For another site, say in one line that only GitHub is supported so far: setup writes the parts that work anywhere, plus `.claude/rules/code-host.md`, which lists the GitHub-only parts and how each session reads them on that host. Save `codeHost` as `github`, `local` or `other`. For `local` and `other`, the AI reviews and the board need GitHub: round two offers only the size check (`other` also gets the local review question below) and saves `"aiReview": false` and `"deepEscalation": false`, and "Where the work state lives" is the hand-off file (`"tracker": "file"`), asked nothing. Just this computer is one person's project: skip "Who works on it?" and save `"team": false`.
- **Who works on it?** Just me, or a team.
- **Whose project is it?** Mine, or someone else's (a client or an employer).
- **Private or public?** Private, or public. Recommend private for someone else's project, public otherwise.
- **AI credit in commits?** Keep it out (recommended): commits, PRs and comments carry no "generated with" lines or AI co-author credit. Or allow it.

Round two, each with "All of them (recommended)" first and "Let me pick" second:

- **Checks on every change:** an AI review on every pull request, a deeper review when a change is risky, and a check that fails when code grows past the size limits.
- **How the assistant works here:** writing in plain language, and changes to anything people see made in small steps checked one at a time.

For a "Let me pick", ask one multiple-choice question with that group's items; what is not picked is off. A deeper review needs the AI review: if only the deeper review is picked, say it needs the AI review and turn both on.

With `"githubApps": false` or another site, no CI can run the AI reviews, so ask one more question after round two, outside its "All of them": **Review each change on this computer before it merges?** No, or yes: two fresh reviewers check each change on this computer before it merges, with the verdict rule the CI reviews use, and nothing about them reaches GitHub or the other site. Say in one line that each review round uses the plan's model time. Yes saves `"localReview": true` and writes `.claude/rules/local-review.md`; no saves `"localReview": false`.

For someone else's project (a client or an employer), ask one more:

- **Keep the assistant's files on this computer only?** No, they go in the repo like any other file (recommended); or yes, for a team or organization whose repo must not carry them. Yes saves `"localOnly": true`: setup lists `CLAUDE.md`, `.claude/`, `.bindwright/` and its other files for the assistant in this clone's `.git/info/exclude`, an ignore list git keeps out of every commit, and step 8 offers each file meant for the whole team (README and CHANGELOG sections, issue and PR templates, `.gitattributes`) to keep or drop. Say that a new clone needs setup again, since the files and the list stay in this one.

For a team project on GitHub, ask one more:

- **Do pull requests need named reviewers?** No (recommended when nothing on GitHub asks for one), or yes: ask for each reviewer's GitHub name, or `<org>/<team>` for a team, up to 10, and save them as `"prReviewers": ["<name>", ...]`. Setup then has each PR request those reviewers and merge only once GitHub reports it approved. No saves `"prReviewers": null`.

### Where the work state lives

GitHub works here when the repo's remote is on GitHub and `gh auth status` works. When it does not, say why in one line and use the detailed hand-off file (`"tracker": "file"`). Otherwise ask the question below; with `"githubApps": false`, offer only its "GitHub issues only" and hand-off file choices, and skip the board:

- **Where should the plan and the work state live?**
  - A GitHub board with the issues, plus a short hand-off note between sessions (recommended): `"tracker": "github"`, `"handoffFile": true`, and a board as below.
  - GitHub issues only, with the project's status in a pinned issue: `"tracker": "github"`, `"handoffFile": true`, no board.
  - A GitHub board with the issues and no hand-off note, for those who want nothing in the checkout between sessions: `"tracker": "github"`, `"handoffFile": false`, and a board as below.
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

### Mods in this project

Three mods can be turned off for one project while every other project keeps them: `ci-watch`, `tasks` and `skill-check`. The other mods act for the whole computer (shared-pc's line for heavy work, usage-guard's pause, the session-facts line), so only `/bindwright:setup global` turns them on or off. Ask only about the per-project mods installed on this computer (`installed` from step 2, or a yes saved for them); with none, skip this.

Run `python "<helper>/engine/home.py" project-mods <repo root>`: it prints `{"off": [...]}`, the ones already off here. Then ask one multiple-choice question, "Which of these mods run in this project?", one line each on what it does here, with the ones to recommend already picked:

- `ci-watch`: watches each pushed pull request's checks and wakes the session once they finish. Recommend it only with `"codeHost": "github"` and GitHub apps allowed; otherwise say in one line that the project has no CI checks for it to watch, and leave it unpicked.
- `tasks`: keeps the session's task list honest and carries it across compactions. Recommended.
- `skill-check`: checks that the project's session skills ran every step they promise. Recommended.

Every listed mod not picked is turned off here; every picked one is on. Step 6 writes the answers. A run that changes only the mods (offered when the repo was set up before) writes them right away, the way step 6 says, then says which mods are off here and that the change applies from the next session start, and stops.

### What kind of project, for the counts

Only when sharing is on and `counts.mjs status` lists no entry for this repo root. Ask:

- **What kind of project is this?** The page lists the top projects by kind only, as in "Game project 2". Game, business app, developer tool, mobile app, website, other, or "leave this project out".

Save it with `node "<helper>/hooks/counts.mjs" project <repo root> <kind>`, the kind written `game`, `business-app`, `developer-tool`, `mobile-app`, `website` or `other`, or `none` to leave it out, which is remembered so no later run asks again. The counts cover the project's past pull requests too, sent with the first daily send.

Then, for a kind other than `none`, run `node "<helper>/hooks/counts.mjs" history <repo root>`. Only when it prints `"overLimit": true` (more than 500 merged pull requests, the most one send carries), ask:

- **This project has more than 500 merged pull requests. Send the older ones too, in daily batches of up to 500?** "Yes" sends the oldest first, one batch a day, until it catches up. "No" sends only the newest 500 and never the older ones.

Save it with `counts.mjs backfill <repo root> on` (or `off`). On `{"error": ...}`, skip the question: the newest 500 go out.

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
    "codeHost": "github",
    "githubApps": true,
    "prReviewers": null,
    "localReview": false,
    "localOnly": false,
    "tracker": "github",
    "trackerProject": "<owner>/<number> or null",
    "trackerRepo": "<owner>/<name> or null",
    "publicRoadmap": "<owner>/<name> or null"
  }
}
```

With `"localOnly": true`, first run the engine with `--local-exclude <repo root>`, passing the same answers on standard input, so the exclude list is in place before any file is written. It prints `{"exclude": "<file>", "lines": [...], "shared": [...], "tracked": [...]}`. Keep `shared` for step 8. `tracked` names files git already tracks, which an exclude line cannot hide: name each one and say that the repo already carries it, so a change setup makes to it shows in the next commit; step 5 lets the user leave it as it is.

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

First run the engine with `--propose-merge <repo root>`. It changes nothing and prints `{"proposals": [...]}`, one per staged file, each with its `path` and a `kind`:

- `missing`: the repo has no file at that path. Move the staged copy into place.
- `identical`: delete the staged copy.
- `json`: `merged` and `text` are the suggested file: the permission lists unioned, the hooks the repo lacks added (into the repo's entry for the same matcher, or as a new entry), the repo's value kept for every other key both set. `clashes` lists each of those keys with both values (`key`, `repo`, `incoming`).
- `markdown`: `add` holds the staged sections the repo lacks, `differ` the sections both have with different text (`heading`, `repo`, `incoming`), and `repoOnly` the headings only the repo has, which stay.
- `text`: any other file that differs, such as `LICENSE`, and JSON the engine leaves to you (fractions, very large numbers, all-digit keys). There is no suggestion; compare the two by hand.
- `unread`: the repo's path is a folder, a link loop or a link that leaves the repo, so the engine did not read it. Say what is there and ask the user what to do; never read through a link that leaves the repo.

The proposal is a starting point, not the answer. Before showing it, read it against the repo: what the repo's own rules and settings are for, and whether a clash looks deliberate (a stricter permission, a project-specific section, a hook that already does the same job under another name). Adjust the proposal where the repo's intent calls for it. Then show the user, per file, a short summary of the merge, each clash with both versions, and your recommendation for each clash with its reason. Save a file only after a yes.

- `CLAUDE.md`: keep the repo's project-specific sections, and put each added section where it reads naturally rather than appending a second copy of a section.
- `LICENSE`: never replace an existing license without an explicit yes; a license change is a legal decision.
- Delete the staged copy once its file is settled.

In adopt mode, offer every staged file without a repo copy on its own: one line on what it does, move it into place on a yes, delete the staged copy on a no. For a file both have, go through the proposal's clashes and sections one at a time rather than merging the whole file at once.

Then offer the two ways to mark parts of the repo as the project's own, which a later update never changes. In adopt mode, suggest them for whatever the user kept over the new text.

- **Whole files:** `.bindwright/owned`, one repo path or pattern per line (`*` within a folder, `**` across folders, a trailing `/` for a whole folder, `#` for comments), for example the project's own review workflow.
- **Sections of shared files:** a line holding `bindwright:keep` and a later one holding `bindwright:end-keep`, written in the file's own comment style (`<!-- bindwright:keep -->` in Markdown, `# bindwright:keep` in YAML or Python). Markers do not nest.

Mention any `skipped` paths: their staged copies came from an earlier run, and the user decides whether to merge or delete them. The empty folder stays until the end of step 7.

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
- **Size check:** when `.github/scripts/size_check.py` was written, record the breaches the repo already has, after trimming the code-size rule above. It needs lizard: on a yes in step 0, install it now with `<python> -m pip install --user lizard==1.24.3`, the version the size-check workflow pins. When pip refuses because the system or Homebrew manages this Python (its error says `externally-managed-environment`, as on macOS with Homebrew and on Debian or Ubuntu), install it into setup's own environment instead, where the size check looks for it: `<python> -m venv ~/.bindwright/size-check-venv`, then `~/.bindwright/size-check-venv/bin/python -m pip install lizard==1.24.3` (`Scripts\python.exe` on Windows). Never pass `--break-system-packages`. When the install still fails, show why and go on without the baseline; on Debian or Ubuntu a missing `venv` module means the user installs the `python3-venv` package first. The script measures only files git tracks, and nothing setup wrote is committed yet, so first run `git add -N` on every file the repo will keep (the written and merged ones; it stages no content). Then run `python .github/scripts/size_check.py --write-baseline` and say how many breaches it recorded in `.github/size-check/baseline.txt`, which belongs in the commit (with `"localOnly": true` it stays on this computer, in the exclude list). Without lizard (a no in step 0, a failed install, or no Python), leave the baseline out and tell the user the check fails until they install lizard and write it. For `codeHost: "github"` with GitHub apps allowed and `"localOnly": false`, mention that the `Size check` job can be made a required check in the branch rules; for `local`, `other`, `"githubApps": false` and `"localOnly": true` (its workflow stays on this computer with the script), say no CI runs it, so it runs by hand: `python .github/scripts/size_check.py` before each commit.
- `.gitignore`: `.claude/settings.local.json` is personal. If `git check-ignore -q .claude/settings.local.json` fails, add that path to `.gitignore` (create the file if needed). With `"localOnly": true`, skip this: the exclude list already covers `.claude/`, and `.gitignore` is shared with the team.
- **Tracker:** when `.claude/rules/tracker.md` was written, the work state lives in GitHub issues. With a board (`advanced.trackerProject` in `.bindwright/project.json`), check `gh project view <number> --owner <owner>` reaches it; a scope error means `gh auth refresh -s project`. Without one, offer to create and pin the `Project status` issue that `tracker.md` describes. With a public roadmap (`advanced.publicRoadmap`), check `gh api "repos/<public repo>/issues?state=all&per_page=1"` reaches it and returns `[]`: the tool keeps public numbers equal to private ones, so the public repo must start with no issues, pull requests or discussions, which share the numbers; check discussions on the repo's page. Then offer to turn any `ROADMAP.md` items or hand-off file the repo already has into issues, one at a time, with the "New item" command in `tracker.md`; the old files stay until the user removes them.
- `.claude/rules/git.md` names the branches work lands on. If it names a development branch the repo does not have (`git branch --list <name>`), offer to create it from the current branch, locally only.
- Check that every command and path the new files name exists in the repo. Fix what you can; list the rest for the user.
- **Mods in this project:** for each mod asked about in step 3, `python "<helper>/engine/home.py" project-mod <repo root> <name> on` (or `off`). It writes `enabledPlugins` (`"<name>@inline": false`) in this repo's personal `.claude/settings.local.json`, which the CLI reads at each session start and git leaves out, and keeps every other key there. A mod off here does not load in this project's sessions; every other project keeps it. A computer-wide mod is refused. On `{"error": ...}` (a `settings.local.json` that is not valid JSON), show it and say which mods could not be set.

## 7. Set up the computer choices

`.bindwright/global/` holds files for the user's own `~/.claude`, which every project on this computer shares. When it is not there (the `global` path, or `/bindwright:join`), render it: pipe the repo's `.bindwright/project.json` into the engine without `--write` (outside a set-up repo, `{"team": false, "client": false, "advanced": {"codeResearch": "<tool>"}}`), and write each `files` entry whose path starts with `.bindwright/global/` at that path under the repo root (outside a repo, under the current folder), so the end of this step removes it. Set up each computer choice the user said yes to, now or on an earlier run, and skip what is already in place (`installed` from step 2). Nothing here is asked again, except a change of an existing file, which is shown first. Changes go through `python "<helper>/engine/home.py" <command>` (any Python 3.8+ can run it). It backs up `~/.claude/settings.json` before each change, refuses a settings file that is not valid JSON, and prints one line of JSON; on `{"error": ...}`, show the message and skip that extra.

The hooks need a system Python: run `home.py find-python` once. On an error, skip every hook below, and tell the user why and that a later run can add them.

- **Global instructions:** merge `CLAUDE.md.additions` into `~/.claude/CLAUDE.md`, everything from its first `---` line on. Create the file when it is missing. Never add a section the file already has; where the two differ, show both and ask. Then add the line `<!-- bindwright:global-instructions -->` on its own at the end, if the file does not hold it yet: it is how `installed` knows the sections are there, since many people already have a `CLAUDE.md` of their own.
- **Project memory** (always, no question): copy `memory/MEMORY.md` to `~/.claude/projects/<folder>/memory/MEMORY.md`, only when no index is there yet. `<folder>` is this repo's folder under `~/.claude/projects/`: the CLI names it after the repo's full path, with every character other than a letter or digit turned into `-`.
- **Work language** (only when it was answered this run, so a language the user changed later with `/config` stays): `home.py set-language <language>`. For Spanish it sets `language` in `~/.claude/settings.json`, so the assistant replies in Spanish from the next session, and writes `~/.claude/rules/work-language.md`, one line asking for commit messages and code comments in Spanish. For English it removes both, but keeps a `language` the user set by hand for another language: when `previous` names one, say it stays.
- **Code-search tool:** `<helper>/_core/global-template/hooks/code-research-profiles.json` has the chosen tool's install command per system, the step that wires it into the agent, and its indexing step. The install and wiring happen once per computer: skip them when the tool already runs. The indexing step belongs to each project: run it here. Show each command, run it only on a yes, and stop at the first failure.
- **Code-search hook:** when `hooks/` holds a `*-first.py` and `home.py list-hooks` does not show it yet, install it with `home.py install-hook <that file> --python <found> --matcher "Grep|Glob|Bash"`. If `~/.claude/hooks/` already has a different copy, show the difference first. Offer to remove any other `*-first.py` with `home.py remove-hook <name>`, since two of them would fight over every search. Say that the hook blocks searches only while the tool is available.
- **Attribution guard in `~/.claude`:** only when `hooks/` holds `no-ai-attribution.py`, which happens when the project keeps its guards in each person's `~/.claude` instead of the repo. Install it with `--matcher "Bash|PowerShell" --block-on-failure`, so a guard that crashes or times out blocks the command instead of letting it through. If the Python it was installed with is later removed, the guard cannot start and blocks every shell command, setup's and the doctor's included. The way out is outside Claude Code: put that Python back, or delete the two guard entries from `~/.claude/settings.json` in a text editor, then restart Claude Code and run `/bindwright:setup`. Say this once, before the first of the two guards goes in. Then run `home.py attribution-off`, which stops the CLI adding its own credit lines. Save `{"extras": {"attribution-guard": true}}` with `--remember <repo root> --layer personal`.
- **Push guard:** `home.py install-hook hooks/push-guard.py --python <found> --matcher "Bash|PowerShell" --block-on-failure`. It only ever blocks, and `--block-on-failure` makes a guard that crashes or times out block the command instead of letting it through, and one whose Python was removed too (see the attribution guard). The first time it goes in, ask separately: "Let every `git push` run without a prompt in every project on this computer? The guard blocks force pushes written the ordinary way; it cannot see one built at run time, set in git config, or run by another program." On a yes, `home.py allow "Bash(git push:*)"`.
- **Session titles:** `home.py install-hook hooks/session-title.py --python <found> --events SessionStart,UserPromptSubmit`, then `home.py allow "Edit(~/.bindwright/session-titles/**)"`, so writing the purpose file never asks, in any permission mode. It titles every session on this computer from its next start; a name picked with `/rename` stays until the session's purpose changes.
- **Builder agent:** `home.py add-agent agents/builder.md`. A copy already in `~/.claude/agents/` stays (`"kept_existing": true`), since it may hold the user's edits. Agents load at start-up, so the user restarts the CLI after.
- **Reply style:** `home.py add-style output-styles/straight-talk.md` copies the style into `~/.claude/output-styles/` and turns it on (`outputStyle` in `~/.claude/settings.json`). A copy already there stays (`"kept_existing": true`), and its own name is what gets turned on. When it prints a `previous` style, say which one it replaced. It applies from the next session; `/output-style` picks another at any time.
- **Code-style profile:** ask whether to build it now or later. Now: follow `${CLAUDE_PLUGIN_ROOT}/skills/code-style/SKILL.md` from its step 1, then come back here. Later: say to run `/bindwright:code-style` when they have a few minutes; a later setup run asks again until the profile exists.
- **Mods:** install each chosen one with `home.py add-mod "<helper>/_core/global-template/mods/<name>"`. A mod already installed keeps its copy (`"kept_existing": true`), since it may hold the user's edits. Mods load at start-up, so the user restarts the CLI after. The CLI's built-in "You should know" mod stays off: say in one line that it reviews each session with an extra model call and needs telemetry, and that the user can turn it on later.

After a hook install, check it works: pipe `{"tool_name": "Bash", "tool_input": {"command": "git push -qf origin main"}}` into the registered command and arguments on standard input, writing no file (`home.py` printed the settings path; the entry is the last one under `hooks.PreToolUse`). The push guard must exit 2.

Then remove the staging folders: run the engine with `--clean-staging <repo root>` (never `rm -rf`, which the project's settings deny). It always removes `.bindwright/global/`, removes `.bindwright/incoming/` only when no staged copy waits in it, and removes a `.bindwright/` it leaves empty, as outside a repo. It prints `{"removed": [...], "unsettled": [...]}` and refuses a folder that is a link; on `{"error": ...}`, show the message and say which folder to remove by hand. Name each `unsettled` file: a staged copy still waiting to be merged, from this run or an earlier one that stopped, which a later `/bindwright:setup` or `/bindwright:update` offers again.

## 8. Finish

Tell the user, in plain words, in two parts.

**This project:**

- What was written, merged and left out, grouped by kind (rules, skills, hooks, workflows, docs), not file by file.
- Where the work state lives: the board's link and whether it is private, the clean public copy's repo when there is one, or the hand-off file.
- What still needs them: for a repo with AI review workflows, the repository secret and branch rules those workflows describe.
- Which per-project mods are off here, if any, that they stay on in every other project, and that `/bindwright:setup project` changes them. A change applies from the next session start.
- That `.bindwright/project.json` (their answers) and `.bindwright/pristine.json` (the files as generated, before any merge or fill) belong in the commit and are not edited by hand: later updates merge against them, so the repo's own edits survive. With `"localOnly": true` they stay on this computer with the other assistant files, out of every commit.
- With `"localOnly": true`, each `shared` file from step 4, one at a time: drop it (recommended: delete a new file, `git restore` a changed one) or keep it, for the user to commit when the team wants it.
- That nothing is committed yet: they can read the changes with `git diff` and `git status`, and commit when happy.
- That `/bindwright:remove` takes the setup back out at any time, keeping every file they changed.

**This computer:**

- Each computer choice and its answer, one line each (code-search tool, work language, global instructions, push guard, session titles, builder agent, code-style profile, reply style, mods, anonymous review counts), and what was installed this run.
- Where they live and how to change them: `/bindwright:setup global` asks them again, or edit `<config>/bindwright/settings.json` (name the real path). The counts answer and each project's kind live in `<config>/bindwright/counts.json`; `node "<helper>/hooks/counts.mjs" share off` stops every send at once. The next project on this computer will not ask them: `/bindwright:setup project` (or a plain `/bindwright:setup`) there asks only its own questions.
- That `~/.claude/settings.json.bak` holds the settings from before the last change, when one was made.

Do not commit or push. Outside the repo, change only what the user said yes to.

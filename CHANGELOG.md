# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [SemVer](https://semver.org/) from v1.0.0 onward.

Earlier conversational `v17` and `v18` mentions never shipped as standalone artifacts — they're consolidated into the v1.0.0 release.

## [Unreleased]

## [v7.11.4] — 2026-11-22

### Fixed

- **An update merges a JSON file whose keys the repo reordered.** When a repo keeps the keys of `.claude/settings.json` in another order than the templates (its `hooks` block last, say), the line merge read the moved block as deleted, so every change to the hooks came back as a conflict, and taking the templates' side wrote the `hooks` key twice. When the line merge clashes on a `.json` file whose three versions are JSON objects, the update now merges them key by key: the repo's key order and indentation stay, keys only the templates add go at the end of their object, and a key both sides changed differently is still a conflict. So is a file with a kept section the merge would change, a key repeated within its object, a number with a decimal point or exponent, or an all-digit key, which the two engines would not reprint alike.

## [v7.11.3] — 2026-11-22

### Fixed

- **The attribution guard reads a command on a busy computer instead of letting it through.** When the guard's parser took more than 6 s, a git call whose subcommand is built at run time (`git "$@"`, PowerShell's `git @args`) passed unread. Each parse now has 20 s and every parse of one command 27 s, and the guard's hook is stopped at 30 s instead of 10 s, as the version check already is. The version check's own parse has 20 s too. A repo takes the new limits with `/bindwright:update`; a guard installed in `~/.claude` takes the 30 s the next time setup installs it.

## [v7.11.2] — 2026-11-22

### Fixed

- **The `Review gate` summary names the account the backup ran on.** With the API key and only later accounts' tokens, when the step that picks the backup's account fails, the backup runs on the first account that has a token, but its label said plain "(backup)", which reads as account 1. The step that picks who pays now records that first account, and the backup's token and its label in both review tiers read the same one.
- **A file held back from an update merges cleanly on the next one.** When an update leaves a file out of its PR with `--keep-base` (the review workflow, which ships in a PR of its own), the record now also keeps the text it held back. Once the repo holds exactly that text, the next update takes it as the file's base, so the file updates instead of coming back as a conflict made of template changes alone.

## [v7.11.1] — 2026-11-22

### Fixed

- **A repo with the API key and only later accounts' tokens gets its first review attempt again.** With an `ANTHROPIC_API_KEY` secret and account tokens only from `CLAUDE_CODE_OAUTH_TOKEN_2` to `_5`, no first `CLAUDE_CODE_OAUTH_TOKEN`, the first review attempt of both tiers (and the deep tier's same-model retry) had no credential at all and failed at once, so only the backup reviewed. Those attempts now run on the key, and the `Review gate` summary names them as on the API credits; the backup still runs on the account it picks.
- **The key-only notice names the plan-credit limit.** When the API key is the only payer, the run's notice now says that a key holding only a plan's monthly credits pays for the first run alone, since the review action is refused those credits. With the key and only later accounts' tokens, a notice says the same about the attempts on the first account.
- **The backup finds an account when its account check could not run.** When the step that picks the backup's account fails or is skipped, the backup now runs on the first account that has a token, so a repo with only `CLAUDE_CODE_OAUTH_TOKEN_2` to `_5` no longer sends it out with an empty one.
- **`setup-review-gate.sh --check`** takes the API key with only later accounts' tokens as a complete setup, instead of reporting `CLAUDE_CODE_OAUTH_TOKEN` missing.

## [v7.11.0] — 2026-11-22

### Added

- **Setup asks how the AI reviews are paid for.** Your Claude subscription only (recommended), API credits first and then the subscription, or an API key only, each with what it costs you. Many plans come with monthly API credits, so the reviews can spend those before your plan's usage.
- **The reviews run on an API key alone.** With an `ANTHROPIC_API_KEY` secret and no account token at all (`CLAUDE_CODE_OAUTH_TOKEN` to `_5`), every attempt of both review tiers, backups included, runs on the key, and the `Review gate` summary names those runs as on the API credits. Before, every attempt after the first needed a subscription token.
- **`set-review-tokens.sh --api-key`** asks for the API key with the input hidden, like the account tokens, and sets it as `ANTHROPIC_API_KEY` in the same sweep; `--accounts 0 --api-key` sets the key alone. A key typed where an account token belongs is refused.
- **`setup-review-gate.sh --check`** takes an API key with no account token at all as a complete setup instead of reporting the token missing.
- **The plugin's README says what setup changes and how to get help.** Four example prompts, the parts of setup that change how Claude Code behaves in later sessions (each asked one at a time, all plain text) and what `/bindwright:remove` leaves in place, where the helper's scripts come from and how they are checked, and how to troubleshoot with `/bindwright:doctor` and `/bindwright:report`.
- **Releases can leave the plugin directory's copy alone.** While the repository variable `DIRECTORY_HOLD` is set, a release still ships to GitHub and the wrights marketplace, but the `plugin` branch the directory reviews stays put, since each push there restarts the review of the version waiting on it.

## [v7.10.2] — 2026-11-22

### Fixed

- **A subshell inside a subshell is no longer read as arithmetic.** The command reader the ci-watch and tasks mods share took every `((` as the start of arithmetic and hid what followed it, so in `((cd sub); git commit -m x)` the commit was not held, and in `((cd sub); git push)` no watch started. It now reads `((` the way bash does: as arithmetic only when the parenthesis that closes the second `(` is followed straight away by another `)`.

## [v7.10.1] — 2026-11-22

### Fixed

- **A here-doc written `<<\EOF` no longer hides the commands after it.** The command reader the ci-watch and tasks mods share did not take `<<\EOF` as a here-doc, so an apostrophe in its body, such as "don't", read as an open quote and hid every later `git commit` and `git push`: the commit was not held and no watch started. A shift such as `(( a<<b ))` inside a quoted `$(...)` no longer opens a here-doc that is not there.

## [v7.10.0] — 2026-11-22

### Added

- **A commit waits until the task list is current.** With the tasks mod, a `git commit` from the main session is held until the list has changed since the previous commit, so each commit puts what it does on the task it belongs to. The hold lists every open task with its hold and description, so each one is checked against what is true now, and the first file edit after a change names the task in progress. Reading or listing the tasks does not release it. A session with no task tool to release it, and the first commit after a `/clear`, are covered: the first lets every commit through, the second holds like a new session. `task-tracking.md` asks for the same before each commit where the mod is not installed.

### Fixed

- **The ci-watch mod reads pushes and commits the way the shell does.** A `#` comment with an apostrophe in it, an escaped quote, a `<<` inside a quoted message that runs over several lines, and arithmetic such as `$((1<<n))` could hide a real `git push` or `git commit` written after them, so no watch started. The command is now read one character at a time, tracking the quote, here-doc or here-string it is in. A bare `git` followed by a long run of `--flags` no longer slows every shell call: 22 flags took 82 ms and each one more doubled it, and now 200 take under a millisecond.

## [v7.9.0] — 2026-11-22

### Changed

- **PR bodies read like a person explaining the change.** `git.md` § Pull requests, the PR template and the contributing guide no longer ask for 1-3 bullets: a body gives the outcome first in a few plain sentences, says what the change does before naming a file or function, keeps lists for steps and checks, and drops hedges, em dashes and hype, in a professional tone. The reply style points PR bodies at that section (#1160).

### Fixed

- **The attribution guard reads Git Bash drive paths on Windows.** A body file given as `/p/notes/body.md` was looked for at `P:/p/notes/body.md`, so the guard could not read it and refused the commit or PR. It now reads both files such a path can name, drive P's `notes/body.md` and `\p\notes\body.md` on the command's own drive, since Git Bash leaves some arguments unconverted, and refuses the call when either holds an attribution line or neither exists. The same goes for a folder change before a relative body file (#1164).
- **A WSL `bash` started from PowerShell can name its body file as `/mnt/p/...`.** The guard looked for that path on the current drive and refused the call; it now also reads it as drive P, where WSL finds it (#1166).

## [v7.8.0] — 2026-11-21

### Added

- **A session can no longer write repository secrets.** The guard refuses `gh secret set` and `gh secret delete` with a note to hand the user the command, since a test run can overwrite the real secrets and that cannot be undone; being irreversible, this rule enforces from the start instead of observing first. `set-review-tokens.sh` itself stops when Claude Code started its shell (`CLAUDECODE=1`), however the call is spelled, so it runs only in the user's own terminal.

- **The review-token sweep can reach your organizations' repositories.** `set-review-tokens.sh --orgs` also sets the tokens in every repository with the review of each organization you administer, beside your own. It needs the `read:org` scope, and any failed lookup stops it before anything is written, naming `gh auth refresh -s read:org` and `--repo`. A run without `--orgs` works as before.

### Fixed

- **A review that never got to post no longer counts as a red round.** The ci-watch mod counted every failed review gate as a fix round, so a review run that errored, found no account with room, had its post refused or was cancelled pushed a PR toward the research step and the hard stop with nothing to fix. Now such a round keeps the count where it was, and the wake says the review never got to post and asks to watch the re-run. A review that was posted counts, whatever it says, as does every other red round and any round the mod cannot read (#1150).

## [v7.7.1] — 2026-11-21

### Fixed

- **A Python-only helper install no longer races another session's.** With Python and no Node, setup and update installed the helper with a plain `pip install`, so two sessions updating at once could write into the same folder together. The Python engine now has `home.py helper-install`, which takes the same install lock the Node helper uses, checks the download against the plugin's pin, and answers ready, busy or error, as the Node install does.
- **A CI review no longer sits until its timeout waiting for input.** The review workflows started the Claude Code CLI with its standard input left open, so a run could wait on input that never came and hold the job until it timed out. Both review workflows and the account check now start the CLI with its input closed (#1133).

## [v7.7.0] — 2026-11-21

### Added

- **ci-watch notices a background run that goes quiet.** A background shell or subagent the session started whose output file stops growing for 30 minutes, with no notice that it finished, wakes the session once with its name and the output file to read, so a hung or killed run is no longer waited on for good. A run that reports back is forgotten.

### Changed

- **Memory entries carry the date they were written and their source.** The memory format setup teaches adds `written:` and `source:` lines, and the monthly pruning pass also lists entries older than 90 days or with no date, to confirm or drop. The pass is now offered at `/start-session` too, whichever ritual runs first that month, so a session that never closes still gets it.
- **The security rule names scripts loaded from another party's server.** A web page that loads a script from someone else's CDN runs whatever that server sends, so the rule now says to pin such a script to an exact version with an integrity hash, or serve a copy from the project, under a Content-Security-Policy that names the allowed sources, and to keep scripts their vendor changes on purpose (tag managers, A/B testing) off pages that handle sign-ins or payments.

### Fixed

- **The AI reviews move to another account only when the plan is spent or the token is refused.** The check that picks the backup's account now treats any other failure, such as a network error, as a reason to stay on the account it tried, so a passing blip no longer spends another account's window. Each check also runs with only its own account's token, in a home folder of its own, and the step stops after 12 minutes at most.

## [v7.6.1] — 2026-11-21

### Fixed

- **After an early reset, another account's window still pauses when it runs hot.** An early reset fenced the paused window and every older one for any login, so after a `/login` to another account whose window reset earlier, that account could not pause in it. The fence is now kept per account: the account that reset early still drops its stale readings, and every other account drops only a stale reading of that exact window.

## [v7.6.0] — 2026-11-20

### Added

- **The AI reviews can run on up to 5 Claude accounts.** When a review fails and its first account has no room left, the backup review (and the deep review's fallback) runs on the next account that answers a one-line check, so a spent plan stops no pull request until its reset. Each extra account is a repository secret of its own, `CLAUDE_CODE_OAUTH_TOKEN_2` to `CLAUDE_CODE_OAUTH_TOKEN_5`; nothing is checked unless the review failed, and without those secrets the reviews run as before. Setup asks how many accounts the reviews use, and the new `.github/scripts/set-review-tokens.sh --accounts N` asks for each account's token once, with the input hidden, and sets them in every repository of yours that holds the routine review. `setup-review-gate.sh --accounts N` checks that each one is set.
- **usage-guard knows which account is signed in.** A pause records the account it was made on, from Claude Code's login record. After a `/login` to another account whose plan windows have room, the pause ends and the sessions resume their saved work. A session still reading the old account's figures never pauses again for those exact windows, while the new account's own windows pause as usual. A session that also holds an arm set by hand waits instead and shows a card after the switch, with "Lift it here" and "Lift in every session" (`/usage-guard lift`, `/usage-guard lift-all`), since that arm waits for the person.
- **session-facts names the account a session runs on.** The line every prompt carries adds the signed-in account's plan name (`| account Max`), read from Claude Code's login record, never an email. Running sessions follow that record, so after a `/login` to another account the next line names the new account and notes `| switched to Max` once.

### Changed

- **A usage pause gives each session its own resume.** When a plan limit pauses the sessions, each one is armed for the pause's wake on its own, kept apart from any arm set by hand with `/usage-guard arm`, so one session's resume can be cancelled alone: `/usage-guard disarm` and the pause card's new "Cancel resume (this session)" drop this session's resume and its own arm, and the other sessions still resume after the reset. A cancelled resume stays cancelled after a `/clear` or a restart. `/usage-guard disarm-global` (the card's "Cancel resume (all sessions)") cancels every session's resume, the arms set by hand included, and ends the pause. `/usage-guard cancel` still works as the earlier name of `disarm-global`.
- **The review workflows run claude-code-action v1.0.282.** Both workflows also take `AGENTS.md` from the PR's base branch, as the action itself does, and their prompts name it among the files that hold the base branch's copies.

### Fixed

- **A pull request that changes only `AGENTS.md` gets a review.** Claude Code and the review action read `AGENTS.md` as instructions, but triage filed it as docs and passed the PR without a review. Triage now always reviews it at any folder depth, as it does `CLAUDE.md`, and the review's first pass reads it in full.

## [v7.5.0] — 2026-11-18

### Changed

- **Setup's plan says what FindWright's own setup does next.** With FindWright as the code-search tool, the plan names its plugin and then its own setup, which checks what FindWright still needs on the computer and in the project, shows its own plan of it and asks before it changes anything (FindWright 2.3.0 and later), so nothing FindWright installs rides on a yes that did not list it.

## [v7.4.0] — 2026-11-18

### Changed

- **Two sessions updating the helper at once take turns.** With Node running the helper and one already installed, setup installs the new one through the helper's own install command, under the lock the helper's update at session start already takes, so a second session waits for the first instead of writing the same folder at the same time. Setups that run the helper with Python, a first install, and a helper from before this release keep the plain steps, without the lock.

### Fixed

- **Two sessions installing the helper at once no longer delete each other's download.** Setup's helper install, which `/bindwright:update` and the other commands run too, downloaded the release file to the same path in every run and deleted it after installing, so a second session installing at the same moment could find its checked file gone and fail. Each run now downloads into a folder of its own and removes it on every way out, a failed download included.

## [v7.3.0] — 2026-11-18

### Added

- **Setup shows the whole plan before it changes anything.** After the questions, `/bindwright:setup` lists every project file it will add or merge, each GitHub board or repo it will create, and every change to the computer (hooks, `settings.json` entries, mods, reply style, agent, code-search tool), then writes it on one "Apply all of this?"; the few steps that need something more from you, such as the verify skill or the code-style profile, still ask on their own. A no leaves the repo, `~/.claude` and GitHub as they were; until then setup saves no answer and changes nothing but what every run needs: the helper, which running the command installs, and, each on its own yes, the programs, the Git identity, `git init`, the removal of an older Bindwright's FindWright copy and finishing an earlier setup's merges. Lizard and the commit-check manager install after that yes, with no question of their own, since picking the check is the yes to them.
- **Setup offers the recommended answers in one go.** A first or project run starts with one question: the recommended answer for everything, or each choice. The recommended path still asks what has no safe default (who works on the project and whose it is, a public repo's work items, the review counts, replacing an existing reply style, named reviewers for pull requests, and any question that recommends no answer for the repo) and goes straight to the plan, which shows each answer it took with the warning its question would have given.
- **The weekly pin check holds the hand-pinned Bun to the review action's own.** The review workflows bring the Bun the action uses, with its version and checksums set by hand, so an action bump could keep handing it an older Bun unnoticed. `pin_check.py` now reads the `bun-version` of the action pinned in the same workflow, on GitHub at that commit, and lists a Bun that differs from it, or one it could not check.

### Changed

- **Setup sets FindWright up in the same run.** With FindWright as the code-search tool, `/bindwright:setup` installs its plugin and then follows FindWright's own setup from its install path, as `/bindwright:update` already does with FindWright's update, so its helper, model, registration, guidance, search hook and the project's fit are in place when setup ends, and only its tools wait for the next session. It used to end with a restart and `/findwright:setup` for the user to remember.
- **Running a Bindwright command is the yes to install its helper.** `/bindwright:setup`, `/bindwright:update` and the other commands that need the helper install or update the one the plugin pins without asking first, and say in one line what they installed, the way FindWright's setup already does. The helper is a requirement, so a no could only stop the run. The SHA-256 check and the stop on a failed install stay. `/bindwright:report` is now a command only you start, like the rest, so the assistant cannot run it, and the install, on its own.

### Fixed

- **The release version check no longer runs a pull request's own script in a CI review.** The hook ran `.github/scripts/version_check.py` from the checked-out repo, which in a CI review is the pull request's, so a reviewer command naming a release could run that pull request's code with the review's token. It now does nothing in a GitHub Actions run, where no release is made through the assistant. `/bindwright:update` brings the fixed hook into each project.

## [v7.2.0] — 2026-11-18

### Added

- **One `/bindwright:update` brings every wrights plugin and helper current.** A plugin update left both helpers behind, and FindWright's waited for `/findwright:update`, a command a Bindwright user has no reason to know. The update now starts by refreshing the wrights marketplace and, on one yes, updating each installed wrights plugin that has a newer version, asking for a reload and a second run when Bindwright itself moved. After Bindwright's own helper, it runs FindWright's own update from FindWright's installed plugin, which decides for itself what is behind.
- **Plugin auto-update is on by default.** Claude Code leaves auto-update off for marketplaces outside Anthropic's, so a Bindwright or FindWright installed from the wrights marketplace stayed on its version until someone opened `/plugin`, which the phone app cannot reach. Setup now turns on Claude Code's own auto-update for the wrights marketplace in `~/.claude/settings.json`, without a question: new versions arrive by themselves a few minutes into a session, and the next start uses them. A computer set up earlier gets it at its next `/bindwright:update`; `/bindwright:setup global` turns it off, and `/bindwright:remove` takes it back out.
- **The helper follows the plugin by itself.** Once the plugin moves, by auto-update or by hand, the next `/start-session` installs the helper version the plugin pins, checked against its SHA-256 the way setup checks it, and says so in one line; a failure keeps the old helper and names `/bindwright:update`. The hook copies setup installed into `~/.claude/hooks` follow the helper too: right after it moves, a hook whose files all still hold exactly what was installed takes the new helper's text, its module folder included, and a refresh that fails is tried again at the next `/start-session`; a hook with any file you edited stays whole, and the line names it with the folder that holds the new text. Copies installed before this release start following from their next install. FindWright's helper does the same from FindWright 2.2.0, so one release moves both plugins and both helpers with nobody typing a command.

### Changed

- **FindWright's own setup carries what the agent needs to know about FindWright.** Bindwright wrote FindWright's tool list, lookup sequence, fallback marker and session-close hit rate into the files it binds, so a FindWright release that changed how its tools are used needed a Bindwright release too. With FindWright 2.2.0, `/findwright:setup` installs that guidance itself, and Bindwright keeps only the choice of FindWright, its install and one line pointing at `/findwright:find`. Close-session runs the step the code-search tool's own guidance names for the end of a session, and the grep-versus-tool count (`research-adherence.py`) now ships only for a custom tool: `/bindwright:update` offers to remove it from a FindWright project. Every FindWright release ships `/findwright:find`, with its fallback cases, so an older FindWright keeps its lookup steps; its session-close search report returns once FindWright moves to 2.2.0, which `/bindwright:update` offers.

### Fixed

- **An empty `CLAUDE_CONFIG_DIR` no longer sends the mods to the root of the drive.** The mods kept an empty value as set, so they read and wrote `mods-data/`, their settings and Claude Code's own files from paths such as `/mods-data/<mod>/`. They now treat an empty value as unset and use `~/.claude`, as the engine, the helper and the hooks already did; any other value is taken as given, the way Claude Code takes it.

## [v7.1.0] — 2026-11-17

### Added

- **`/bindwright:update` can hold a file back for a later PR without losing its change.** An update that changed the routine review workflow had to ship it in a PR of its own, but the record of what the update wrote already listed the new text, so the next update read the old copy as a local edit and kept it. The engine's new `--keep-base` puts a held-back file's record back to the one the update replaced, and the update skill runs it for every file left out of the commit, the workflows whose new action pins wait for a second PR included.
- **`/bindwright:update` offers the newer reply style.** A computer whose Straight Talk is an earlier Bindwright copy, unedited, is offered the current text, and it is replaced on a yes; a copy with the user's own edits stays as it is. `home.py style-status` tells the two apart from the fingerprint of every earlier shipped copy, kept in `straight-talk.retired.json` beside the style.

### Fixed

- **The layout check stops its browsers on a busy Windows machine too.** The query that finds them gave up after 20 seconds and read as no browsers, so a slow machine could leave a headless browser running; it now waits up to 60 seconds.
- **The review workflows install the attribution guard's parser offline.** The helper the CI review jobs install came with its pinned checksum, but npm could still fetch its dependencies from the registry unpinned, in a job that holds the review token; both workflows now install it with `--offline` from an empty cache of their own, and a missing package stops the step.
- **The review workflows ignore the runner's own curl and npm settings.** On a self-hosted runner reused between jobs, a `~/.curlrc` or `~/.npmrc` an earlier job left could change the downloads, the bot-token exchange or the CLI install; every curl now starts with `-q` and npm reads no user config. npm also reads no global config now (`etc/npmrc` in the runner's own Node folder), and the tests workflow's Go download skips the runner's curlrc too.
- **The review action's Bun ignores what an earlier job left on the runner.** The pinned review action installs its packages with Bun, which read a global `~/.bunfig.toml`, reused packages and compiled code from caches in the runner's home without checking them again, and came from a setup step that keeps any Bun already in `~/.bun/bin`. Both review jobs now give Bun an empty config folder and cache of their own, turn its runtime cache off, and on Linux bring Bun themselves, checked against the checksum Bun publishes.

## [v7.0.0] — 2026-11-17

### Breaking

- **Bindwright's own marketplace is gone: the plugin ships only through the wrights marketplace.** This repo no longer lists the plugin in `.claude-plugin/marketplace.json`, so an install added with `/plugin marketplace add starfoxcom/bindwright` stops getting updates. Move it with `/plugin marketplace remove bindwright`, then `/plugin marketplace add starfoxcom/wrights` and `/plugin install bindwright@wrights`. An install from `starfoxcom/wrights` or the plugin directory needs nothing.

## [v6.0.0] — 2026-11-17

### Breaking

- **Setup needs CLI 2.1.295 or later.** The guard hooks block a command when they crash or run out of time only from that version (`onFailure: block`); on an older CLI a guard that fails lets the command through. Setup now checks the version the session runs before it writes anything, offers the update, and stops on a no, since every setup writes guards. `/bindwright:doctor` names an older CLI wherever guard hooks run, in the repo or in `~/.claude`, not only where mods are installed.

### Added

- **Setup writes a verify skill that checks a change in the running app.** For a project with something to run (an app, a web page, a server, a game, a command-line tool), setup asks whether to check each change in the running app before it is committed, with what it catches and what it costs. On a yes it writes the project's own `/verify` skill from what it reads in the repo: how to start the app and know it is ready, how to reach the changed part, and what to look at, the layout check included for a web page. The session runs it before each commit of a change people can see or use, the visual rule names it in place of a plain headless start, and `/close-session` says whether it ran on each such change. The project owns the skill, so updates never touch it.
- **The reply style stays fresh in long sessions.** The CLI puts the output style at the top of a session, and the longer the session runs, the more it sits under, so replies drift from it. Setup now installs a hook with the reply style that restates the active style's own text with every prompt and after every 25 tool calls in a turn, so it is the last thing read before a reply; on a computer that already has the style, the next setup run adds the hook. It follows whichever style is in use, the project's setting first, and adds nothing for a built-in style, which has no file. Removing the reply style removes the hook. Under Straight Talk, the same hook also checks each finished reply, up to its first code block, for the slips a pattern can see (bold labels, em dashes and the banned filler phrases) and names them with the next prompt, so the correction points at the actual slip; a clean reply adds nothing.
- **A version check holds each release to its commits.** Setup finds how the project already numbers its releases (its tags, a `VERSION` file or its manifest) and offers to enforce it; with none, it recommends one for the kind of project: semantic versions for anything other code builds on, semantic versions with `-alpha.N`, `-beta.N` and `-rc.N` builds for a game or anything tested in stages before launch, calendar versions (a calver.org format such as `YYYY.MM.MICRO`) for an app or service shipped on a schedule, or none. `/bindwright:update` asks the same once in a project set up before. With either numbering it writes `.github/scripts/version_check.py` and, where the guard hooks live in the repo, a hook that runs it before `git tag <version>`, `gh release create <version>` and `gh pr create` from a `release/<version>` branch. For semantic versions it reads the commits since the last release tag and refuses a release smaller than they need: a `feat` needs a minor, a `fix` or `perf` a patch, and a `!` after the type or a `BREAKING CHANGE:` line a major (before 1.0.0, one step less), measured from the last release without a pre-release tag; pre-releases must come in order, alpha before beta before rc before the release. With a Keep a Changelog file, a release's section (not a pre-release's) must hold `### Breaking` for a major or a breaking change, and only where the version may break (before 1.0.0 a minor may), `### Added` or `### Changed` when a `feat` is in the range, and only `### Fixed` and `### Security` for a patch from 1.0.0 on. A shallow clone is refused until its history is fetched, since its older tags are missing. The hook reads each command the way the shell does, with the parser in Bindwright's helper, so a release command quoted in a message or a here-document is not taken for one. The parser is required: on a computer without the helper or Node, or for a command the parser cannot read, a command that may make a release is blocked with what to install, or how to turn the check off. For calendar versions it checks the format and that the version comes after the last one. A project that answers none gets nothing. The All settings page lists the new answer.
- **`/close-session` reports what FindWright saved.** With a FindWright helper that estimates it, the hit-rate step adds one line: an estimate, in dollars, of what the session saved in the main session and in helper sessions, counting only the extra turns a missed search costs, so it errs low. Before any miss is recorded, it says the saving is not measurable yet and why, and it names any model it could not price. With an older helper, the step reads as before.

- **A tool-rules guard refuses the shell patterns a session keeps falling back to.** Rules a session only remembers, it drifts from, so each "stop using X, use Y" correction is now a row in one guard, installed with the push guard in the repo and in `~/.claude`. Its first rows refuse an inline script holding a backslash (a here-document or here-string an interpreter reads as its script, `python -c`, `node -e`), which the shell or the interpreter changes before it runs; `gh run watch`; the size check chained with a commit or push; `git push` and `gh pr create` in one command; `git checkout <rev> -- <path>`; `gh pr merge --admin`; and, in Git Bash on Windows, a git object path that starts with a dot (`<rev>:.claude/x`), which Git Bash rewrites. Each refusal says in one line what to use instead. Quoted text, here-document bodies and here-string bodies are not read for the rows after the first, so a message that only mentions a pattern passes. A computer that already has the push guard gets this guard on its next `/bindwright:setup`. Each row carries its mode in the guard itself, never in a file a session could write: a row new to the guard ships in observe mode, which lets the command run and appends what it would have refused to `~/.bindwright/tool-rules/observed.jsonl`, with each run of 24 or more letters, digits and `_-+/=` that holds a digit replaced by `<token>`, and a later release makes it refuse once that log shows no false refusals. `/bindwright:doctor` reports the log per row and names any command that only mentioned a pattern. The rows above refuse from the start. Five more rows ship in observe mode, each from a rule a session kept drifting from: a re-run of only some jobs (`gh run rerun --failed` or `--job`), which can leave a required check stuck; an interactive git command (`git rebase -i`, `git add -p` and the like), which waits for keys a tool call cannot give; an inline body for `gh pr` or `gh issue` (`--body`, `-b`), which the shell can cut or change; a scratch file in `/tmp` or `C:/tmp`, which other sessions share; and `jq` in Git Bash, which has none.

- **The review guide keeps a checklist each diff triggers.** `.github/review-guide.md` gains a Checklist section: each item names a trigger the diff shows, the check to run and the PRs it came from, and both review tiers check only the items whose trigger matches, so a lesson from an earlier breakage reaches every later review without anyone remembering it. The template ships one example item to replace. The review rules now say that a finding seen on a second PR becomes an item in that same PR, or in the next one when that PR must hold only its own files (a review-workflow edit, a gate repair).

- **`/close-session` offers a monthly pruning pass.** Rules, tests and memory only ever grow, and a long rule file is where a session reads past a rule. At most once every 30 days, `/close-session` asks whether to look for what nothing uses any more: rule text that repeats another file or names something gone, tests skipped for good or failing for the same reason as another, and memory entries about files that no longer exist or that the rules already say. The first offer comes a month after the first close that runs it. It only reports, as a linter does: it lists each candidate with why and writes nothing, so what to remove, and where, stays the user's call. The date of the last pass lives in the clone's git config (`bindwright.lastPruning`), which its worktrees share and no commit carries.

### Changed

- **The testing rule allows seeded sweeps for parsers and guards.** Rule 5 of the testing rule, and list C of the test audit that checks a suite against it, kept seeded sweeps to codecs, determinism and range invariants. They now also allow one for a parser or guard that reads free-form text such as a shell command, where the spellings mix and no table can list them. The attribution guard's tests gained one: 300 runner chains per run, read by the real parser in one call, with the seed in each failure so it replays.
- **A step back near the hard stop looks wider.** The research owed before the fix of the 8th, 9th and 10th red review rounds in a row now takes at least five lookups of different solutions, compared against each other, instead of three, so the last tries before a PR has to be rebuilt search wider. The ci-watch mod's wake asks for five there and holds edits, commits and pushes until five lookups ran; `review-tiers.md` and `local-review.md` say the same.
- **The security rule covers testing your own code.** Fuzzing and proof-of-concept exploits against the code the project runs (its own parsers, sandboxes, file formats and protocols, and the libraries it bundles or installs), and taking apart content people send the project, are in scope when the test attacks a copy it starts itself or a test copy the owner runs; live services and other people's systems are not. When the assistant declines any part of this work, it says so plainly and names the part it will not do, instead of working around its safeguards.
- **Every project is offered the commit checks, not only a team's.** Setup now asks each project, solo ones included, whether to check each change on the computer before it is committed, and recommends it: lefthook (or the hook manager the repo already uses) runs the lint, the type check and, with the size check on, the size check before each commit, and the tests before each push, so commits stay fast. Where no CI runs, setup says it is the only automatic check the project gets. The size check runs with the first Python 3.8 or later it finds (`python3`, `python` or `py`). A yes installs the manager's program when it is missing (lefthook, pre-commit, or husky and simple-git-hooks through npm); a no, or a declined install, leaves the checks off. With husky, setup writes one file per git hook: `.husky/pre-commit`, `.husky/commit-msg` and `.husky/pre-push`. With the checks on, the project's deny list also refuses `git commit --no-verify`, `git push --no-verify` and each manager's off switch (`LEFTHOOK=0`, `LEFTHOOK_EXCLUDE=`, `HUSKY=0`, `SKIP=`, `SKIP_SIMPLE_GIT_HOOKS=`), the usual ways around them, even where the attribution guard is off. A project keeps its manager answer until setup runs again; an update adds the size check to the hook config it already has when the size check is on.
- **The attribution guard ships as a hook file and a folder of modules.** `no-ai-attribution.py` keeps the attribution patterns, the test for which commands name a write or a hook change, and the decision, and the new `no_ai_attribution/` folder beside it holds the shell reader, the file reader and the hook routes, so the guard stays inside the code-size limit. Setup and update write the folder with the hook, in the repo or in `~/.claude`, and removing the hook removes the folder. A hook file found without its folder refuses a command that names a write or a hook change, as the guard does without its parser, names the copy command that restores the folder from Bindwright's helper (or `git checkout` where the repo commits it), and lets every other command through. `home.py remove-hook` now refuses anything but a hook's file name.
- **Setup writes the skill-check mod's contracts.** The mod checks only skills with a contract in `~/.claude/skill-contracts.json`, and setup wrote none, so a mod turned on checked nothing until its example was copied in by hand. With the mod on in a project, setup now writes that project's contracts for `/start-session` and `/close-session`, keeping only the steps of the features the project turned on (the tracker it uses, the hand-off file, the code-research tool, a remote host), and `/bindwright:update` refreshes them when the session skills change. An existing entry for the project is replaced only on a yes. The example's steps now match the current session skills: the tracker's open items and FindWright's hit rate, in place of the dated hand-off file a project with the GitHub tracker no longer writes. Steps `/close-session` runs after a PR's checks wake the session (the tracker hand-off, `.bindwright/handoff.md`) stay out, since the mod judges a run when its first turn ends.
- **Setup shows what each mod gains and costs.** Before asking which mods to turn on, for the computer or for one project, setup now says for each one what turning it on gets, what it costs (a hold, a wait, a few tokens, a row above the prompt) and what leaving it off gives up, so the choice is made knowing both sides. The mods README holds the same table.
- **The 10th red round in a row drops the PR for a rebuild.** The review rules now make the 10th red round the hard stop: the PR is closed without merging and the change is rebuilt from its base branch in a new PR, with that round's findings fixed in the rebuild, and the new PR starts its own count. The ci-watch mod's wake at that round says so, `/ci-watch rounds` names it, and the session's `git commit` and `git push` are refused until the PR is closed. The research step backs at the 3rd, the 5th and every red round from the 6th stay as they were.

- **The review counts tell rebuilds and dropped PRs apart.** A rebuild of a PR closed at the review rules' hard stop carries a `Rebuilds #<old number>` line in its body, and a PR closed unmerged for good carries `dropped: no fix` or `dropped: not needed`; the review rules and the ci-watch mod's hard-stop wake say so. The anonymous review counts, for projects that share them, now add the merged rebuilds by how many red rounds they took and the PRs dropped in each window by their label.

### Fixed

- **Setup puts back a guard whose entry is gone or whose Python was removed.** Setup counted the push guard, the attribution guard and the session-title hook as installed whenever their file was in `~/.claude/hooks/`. After the way out for a removed Python (deleting the guard's entry from `~/.claude/settings.json`), the file stayed, so the next `/bindwright:setup` installed nothing and the guard stayed off without a word. A hook extra now counts as installed only while an entry in `~/.claude/settings.json` runs its file with a program this computer has; otherwise setup installs it again with the Python it finds, and `/bindwright:doctor` lists it as missing.
- **A step back holds only the red PR's work.** When a watched PR's red rounds call for research, ci-watch held every edit, commit and push in the session, so a green PR on another branch waited on the red one. It now lets through work it can see is not the red PR's: an edit in a folder, or a plain `git commit` or `git push` from the Bash tool in the shell's folder, when that folder is on another branch and its history holds none of the red PR's commits, so a renamed branch or a fork's checkout of the PR still waits. Plain means steps joined by `&&`, `;` or new lines, each a `git commit` or `git push` with no folder of its own, made of bare path words and whole quoted words with nothing inside that expands or escapes; a push takes only `-q`, `-u`, `-v` and plain names. A push also lifts only when no local branch holds the red PR's work, no remote of its folder has a mirror or push setting, submodules are not pushed with it, and `push.default` is `simple`, `current`, `nothing` or unset. Branch names compare without case. Anything else still waits, as before: a `cd` or `git -C`, a PowerShell command, a command that names the red PR's branch, a shallow clone, an answer from git that is not a clear no, a branch switch, a subshell or group, an expansion, an escape or comment, other git options, a refspec with a colon or a pattern, or an `env` or `GIT_DIR` prefix.
- **The attribution guard reads a body file named inside a brace.** Bash expands a brace of plain text before it runs the command, so `git commit {-F,msg.txt}` runs `git commit -F msg.txt`, but the guard took the brace for text built at run time and never read the file. The helper's bash parser now also gives the words bash makes of such a brace, dropping the empty ones bash drops, and the guard checks the command both ways: as written, as before, since a shell that does not expand braces (dash, `set +B`) runs it that way, and as bash expands it, so the file is read and `{-n,-m} x` counts as `-n -m x`. A second reading only adds checks, so nothing the guard refused before passes now. A brace that holds a variable, a file pattern, a `$` or a backtick (`{$,x}HOME` becomes `$HOME`, which bash expands again), a letter range across the cases (`{Z..a}` makes `[` and `\`, which bash reads again), or that would make more than 256 words, gets no second reading. A file flag held in a variable (`git commit $F`, with `F="-F msg.txt"`) still passes unread, as the guard's notes now say: refusing every variable in a write would refuse ordinary commands such as `git tag v1.2.0 $SHA`.
- **The attribution guard follows more folder changes.** A `cd` behind `builtin` or `command` (`command -p` too, but not `command -v`, which only prints) and `env -C <dir>` or `--chdir` now move where a relative body file is read, so `env -C sub git commit -F msg.txt` reads `sub/msg.txt`. `git commit -t <file>`, the short form of `--template`, is read as a body file too; on `checkout`, `branch` and `switch`, where `-t` means track, it is not. So is a file after `-F` at the end of a short cluster (`git commit -aF msg.txt`, `-aFmsg.txt`). A `cd` that a loop or a function runs again now moves on from the folder its last run reached, so `for i in 1 2; do cd sub; done; git commit -F msg.txt` reads `sub/sub/msg.txt`.
- **The attribution guard reads a command a shell runs from a string.** `bash -c '...'`, `sh -c`, `pwsh -Command` and Windows PowerShell's plain command string were passed unread, so `bash -c 'git commit --no-verify -m x'` skipped every check. Each argument of a POSIX shell that names a git or GitHub write is now parsed and checked like the command itself, up to three shells deep, whatever options come before it; one built at run time, or nested deeper, is refused. A nested `pwsh` or `powershell` whose text names such a write is refused, since PowerShell joins its arguments into a script the guard cannot rebuild; run git directly instead. A script block passed to it after options alone (`pwsh -NoProfile -Command { ... }`) is read with the rest of the command, and the words after a `.ps1` file it runs are that script's parameters.
- **The attribution guard refuses a git call whose subcommand is built at run time.** `git "${args[@]}"`, `git "$@"` (in a function too) and PowerShell's `git @args` give git its subcommand and options from a list the guard cannot read, so a commit inside one passed unchecked. A git call whose subcommand place holds such a word, with no literal word other than an option written right after it (`git "$@" -m x` and `git "$@" -sm x` included), is now refused with a note to write the subcommand out, however git is spelled (`git.exe`, `g'i't`, after `sudo`, `env`, `timeout` or another common runner, behind options and redirections, or with the list in an option's value as in `git -C "$@"` or `git --namespace="$@"`; a git behind any other program, such as `flock f git "$@"`, and one behind a redirection holding `&`, such as `git 2>&1 "$@"`, are not read). A call with a literal word right after it (`git $OPTS commit`, `git log "$range"`, `git config "$@" user.name x`, and also a pathspec such as `git "$@" .`) is read as before, and so is one where only git's own options stand between an option's list and a subcommand written out (`git -C $d --no-pager log`, `git -C "$@" -c x=y commit`), which git reads before the subcommand, and so is a command that only names git as an argument (`grep git "$file"`, `cp -r "$src/.git" "$dst"`).
- **The review trial starts no judge where every review failed.** When a usage limit or a crash stopped every review of a pull request, `/bindwright:review-trial` still started its judges on it, the costliest calls of the run, to score nothing. A pull request with no review now gets no judge, and a run where every review failed stops before judging and says why.
- **The tool-rules guard reads every PowerShell here-string.** PowerShell takes blanks after `@'` or `@"` and an empty body (`@'` with the closing `'@` on the next line), but the guard read neither as a here-string: a script with a backslash piped to `python -` from a header with a trailing space ran unchecked, and after an empty here-string the guard read up to a later `'@`, so a command between them passed unread. Both now read as PowerShell's own parser reads them.
- **The commit-message check accepts a breaking change.** The commit-message check of lefthook, pre-commit, simple-git-hooks and husky refused `feat!: ...` and `fix(scope)!: ...`, the marker Conventional Commits uses for a breaking change, so a project with the checks on could not mark one. It now takes the `!` after the type or scope.

### Security

- **Long commands no longer run the guards out of time.** Random and hostile commands fed to every guard made none of them throw, but several patterns took time that grew with the square or the cube of a command's length: the attribution guard's tests for a GitHub write (`gh pr ... create`) and a hook change (`git config ... hook`), its attribution phrases after "made by" or "ai" and a co-author trailer followed by a long run of blanks, the version check's first pass for a release command, and the tool-rules guard's reading of PowerShell here-strings, its masking of tokens in the observe log, its blanking of shell arithmetic in a here-document, and its checks for a flag after `gh pr merge`, `gh run rerun`, an interactive git command, `gh pr create` or `git show`. A 2 KB line of repeated `gh pr` took 5 s and a 20 KB one more than a minute, past the hook's 10 or 30 s limit, so the command was refused, and on a CLI older than 2.1.295 it would have run unchecked. Each now takes time in step with the command's length and gives the same answers (compared on 20,000 random commands), and those 20 KB inputs take under 20 ms. The PowerShell quote scan keeps its reading: it now tries a here-string opener only while a line that may close it follows.
- **The push guard refuses a command its own check fails on.** An error inside the check let the push through; it now exits as a crash does, which the hook entry's `onFailure: block` refuses.

## [v5.3.1] — 2026-11-15

### Fixed

- **The layout check no longer counts toward locking your Windows account.** On Windows, Chrome and Edge started with a new profile check whether the account's password is blank by signing in with an empty one, and Windows logs that as a failed sign-in. The layout check starts the browser with a new profile on every run, so each run cost one failed sign-in, and ten in ten minutes lock the account under Windows' default policy. Each new profile now carries the answer the browser caches, so it skips the check: a run makes no failed sign-in.

## [v5.3.0] — 2026-11-15

### Added

- **The tasks mod brings its own task tools where Claude Code offers none.** Some builds and models hide `TaskCreate` and the other task tools even with `CLAUDE_CODE_ENABLE_TODO_TOOLS` set, and the tasks mod answers those tools, so it did nothing there. When a session has no `TaskCreate`, the mod now registers its own `mcp__tasks__taskmod_create`, `mcp__tasks__taskmod_update`, `mcp__tasks__taskmod_list` and `mcp__tasks__taskmod_get`, answered from the same list, and its prompts and the task-tracking rule name them; where the built-in tools are there it adds none.

## [v5.2.1] — 2026-11-15

### Fixed

- **Installing the tasks mod turns on the task tools it answers.** Claude Code hides its task tools on current models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set, and the tasks mod answers those tools, so without the setting it did nothing. Installing the mod now sets it, and the mods question says so first. Where an earlier setup installed the mod, `/bindwright:update` names the line to add. Removing the mod leaves it, since it only turns on Claude Code's own task tools.

## [v5.2.0] — 2026-11-15

### Added

- **`/bindwright:update` offers to move an old hand-off file into issues.** In a project whose work state lives in GitHub issues, an update that finds an old `*-CONTEXT_*.md` hand-off file at the repo root says `/start-session` no longer reads it, offers to turn its open items (and any in a `ROADMAP.md`) into issues one at a time, as setup does, then offers to delete the hand-off file. Until now only running setup again offered this.

### Changed

- **The reply style sounds more like a person.** Straight Talk now asks for varied sentences and a colleague's reactions instead of the same report skeleton every reply, and matches the user's register down to swearing: an occasional one where a person would use it, only when the user swears too, never at anyone. It also writes for a reader who loses the thread easily, since that reads well for everyone, and bans bold labels in ordinary explanations. A copy already installed stays as it is, since it may hold your own edits: to take the new text, copy `_core/global-template/output-styles/straight-talk.md` from the Bindwright repository over `~/.claude/output-styles/straight-talk.md`, then start a new session.
- **The find skill names FindWright's fit.** From FindWright 2.0.0 a project's symbols come only from the rules in `.findwright/config.json`, so `/find` says to run `/findwright:fit` when `coverage` shows files the work searches with no symbol.
- **Mod rows stack in one fixed order.** Setup lists the mods in the order their rows should stack above the prompt, whatever order they are picked in: the PC queue on top, then runners, the usage pause, CI, tasks, the session row, and the budgets row last, right above the prompt, since it is read most. A mod of your own keeps its place. An existing list is not reordered: to get the order, list the folders in `env.CLAUDE_CODE_PLUGIN_DIRS` of `~/.claude/settings.json` as `shared-pc`, `runners`, `usage-guard`, `ci-watch`, `tasks`, `session-info`, `session-facts`, `compact-handoff`, `skill-check`, `mods`, then restart Claude Code.

### Fixed

- **Near the compaction, a session with nothing on its task list lists its next steps instead of stopping.** The tasks mod refuses a turn's end near the compaction only while a task on the list needs no one; with an empty list it sends one prompt to carry on, and a turn that ended again after it sat idle. That prompt now asks the session to put each step it announced on the task list and start the first, so the refusal and the keep-going prompts hold the turn open until they are done.
- **A review gate waiting for a deep review says how to restart one.** Since v5.1.0 the `Review gate` check stays in progress while the deep review a blocked routine review asked for runs. When that deep run never starts or dies before writing its verdict (its access check fails, its runner is lost), nothing settles the check. Each waiting state's summary now ends with the way out: if no deep run is alive, ask again with a comment starting with `@claude review this PR`.
- **The attribution guard refuses a malformed parser reply instead of crashing.** A reply whose run-time words lacked the field saying whether they can expand to nothing, whose commands were not lists, or whose words were neither text nor a run-time word made the guard fail on the git call it read, and a crashed hook lets the call through. Such a reply now refuses the call: as a helper older than the guard when a run-time word lacks a field, as a broken helper otherwise.
- **CI reviews can run plain git reads again.** The review jobs load the project's hooks, and since v5.0.0 the attribution guard refuses every command its text names when it has no parser, so reviewers lost reads such as `git log --grep=merge` and `git tag`. Both review workflows now install the helper release pinned in `.bindwright/helper.json` on the PR's base, checked against its SHA-256, so the guard reads commands there as it does on your computer. Setup and `/bindwright:update` write that pin; without one on the base, the reviews run as before.

## [v5.1.0] — 2026-11-14

### Changed

- **The review gate waits for the deep review a blocked routine review asked for.** When the routine review blocks and calls for a deep review, the `Review gate` check stays in progress ("Blocked by the routine review; deep review in progress") until the deep verdict lands, then fails. A CI watcher now wakes once with both verdicts, so every finding is fixed in one round instead of two.
- **The tasks mod keeps a turn going near the compaction.** When the context is close to the auto-compaction point, a task on the list needs no one and nothing else will wake the session, the mod refuses the turn's end once, so the work goes on instead of stopping on a step the turn announced. A turn that still ends gets the usual prompt to carry on; to stop on purpose, put the open tasks on hold.

## [v5.0.1] — 2026-11-14

### Fixed

- **The attribution guard reads the literal text after a word's run-time part again.** A hook setting or a bypass letter written next to a variable (`git config "$SECTION.hooksPath" /x`, `git -c "$S.hooksPath=/x" commit`, `git commit -${Q}n`) passed in v5.0.0 and is refused again: the helper's parser now reports each run-time word's text with a mark for each part built at run time, and the guard reads that.
- **A declaration with a run-time value no longer makes the command unreadable.** `export "PATH=$HOME/bin:$PATH" && git push` (or `local "x=$1"`) was refused as unreadable in v5.0.0; its name is in the word's literal start, so the guard now reads it. A name built at run time (`export "$KV"`) still cannot be read.
- **A PowerShell cmdlet's parameter is no longer read as a body file.** In a command that also wrote to GitHub, `Stop-Process -Force`, `Start-Process -FilePath` or `Get-Date -Format` was read as git's `-F` with a file named `orce`, `ilePath` or `ormat`, and refused. A native program (`curl.exe -Fbody=@file`) is still read as before.

## [v5.0.0] — 2026-11-14

### Breaking

- **FindWright is a plugin of its own.** Bindwright no longer carries a copy of FindWright or writes its `findwright-first.py` hook. With FindWright as the code-search tool, setup installs the FindWright plugin from the `wrights` marketplace (`starfoxcom/wrights`) and takes out the old hook; then restart Claude Code and run `/findwright:setup`, which installs its helper and meaning model, registers its server, offers its own search hook and fits the index. On a computer that used the old copy, run `/bindwright:update` (or any `/bindwright:setup`): it takes out the old hook and server, which point at files that are gone, and installs the plugin; then restart and run `/findwright:setup`. `/close-session` reads the hit rate from FindWright's own helper.
- **The attribution guard needs Node 18 or later and Bindwright's helper**. It reads every command it guards with the helper's parser and no longer falls back to a text read. On a computer without Node or the helper, or with a helper older than the guard, every git and GitHub write it reads is refused, with a reason that names the fix: install Node, then run `/bindwright:update`. A command the parser cannot read (an array built at run time, PowerShell's `--%`, syntax the parser rejects) is refused with a reason that asks for plain commands. A program built at run time (`$GIT`, `"$S/bin/x.exe"`) is read like any other command: every file flag it names is read, and git's own flags too when its text names git. **Act on it:** install Node 18 or later on a Python-only computer, then run `/bindwright:update`.

### Added

- **Setup and the doctor flag tools behind on releases.** They read the newest release of Node on your line (and whether your line still gets security fixes), Git for Windows, the GitHub CLI, uv and the Claude Code CLI, put a security release first, and offer the upgrade command where one surely applies (else they say how to update) on a yes. Only the tools on this computer are checked, and nothing about you or the repo is sent.
- **The attribution guard refuses the routes past git's own hooks**. For a git program, a wrapped one (`env`, `sudo`) and a word built at run time that names git (`$GIT`) included: `--no-verify` and `-n` on `commit` or `am` (`--no-verify` on `merge`, `push` and `rebase` too), setting or unsetting `core.hooksPath` or a `hook.` setting (`git config`, `-c`, `--config-env`), `--trailer`, a commit that reuses another commit's message (`-C`, `-c`, `--reuse-message`, `--reedit-message`), and turning lefthook off (`LEFTHOOK=0` or `false` set by the command, through `export`, `env` or PowerShell's `$env:`, or `lefthook uninstall`). Options are read as git reads them, bundled (`-nm x`) or shortened (`--no-veri`), with each option's value skipped, so a message that names one passes, and each keeps git's own meaning: `-n` on `merge`, `push` or `tag` is not a bypass, and reading `core.hooksPath` passes. The helper's parser now reports the variables a command sets.

### Changed

- **Bash commands are read by mvdan.cc/sh, the parser shfmt uses**, built into the helper as WebAssembly (`helper/parsers/shell-words-bash.wasm`, rebuilt byte for byte from `tools/shell-words-bash`), in place of tree-sitter's bash grammar. It reads what that grammar misread: a here-doc with a redirect or another command on its first line, two here-docs on one line, and a redirect between a command's words. PowerShell is still read with tree-sitter.
- **Bindwright installs from the wrights marketplace.** `/plugin install bindwright --marketplace starfoxcom/wrights` installs it from `starfoxcom/wrights`, which lists Bindwright and FindWright side by side, each pinned to its own release zip by SHA-256. An install from Bindwright's own marketplace keeps updating from it for now.
- **The plugin handles no credential, so the directory has nothing to hold.** `/bindwright:local-runners` no longer fetches a runner's registration code: the user runs the registration in their own terminal, and `config.sh` asks them for the code GitHub shows on the repo's runner page. Taking a runner off works the same way. Setup's helper download names the home folder as a placeholder instead of an environment variable. The pack's directory check now refuses any line that names an environment variable or a credential word beside a network call, the pattern the directory's policy scan holds for a reviewer, and reads skill frontmatter only in the form `key: text` or `key: "JSON string"`.
- **Session titles follow the work after a compaction or a resume.** The session-title hook now names the purpose the session wrote earlier and asks for a rewrite if the work has moved on, so a long session's title no longer sticks to its first task. A title a hook sets still shows only locally: Claude Code does not pass it to the Remote Control name on the phone or the web, where `/rename` or a name given at launch is the way.
- **Near the compaction, a turn's end gets a nudge to carry on.** When a turn ends with the context at 75% of the auto-compaction point or more, nothing pending to wake the session and no workable task on the list, the tasks mod sends one prompt to go on with the step the turn announced, since the compaction carries the context across. A second turn end with nothing changed gets no more.
- **A step back holds the fix until three options are researched.** When a watched PR's red rounds reach a step back (the 3rd in a row, the 5th, and every one from the 6th, with no last one), the ci-watch mod refuses the session's file edits, `git commit` and `git push` until three web lookups on different topics (WebSearch, WebFetch or the web-fetch agent) have run after that red wake, and asks for the three to be compared before the fix. A green round ends it, subagents and closed PRs are not held, and `/ci-watch stop` lifts the hold where web tools cannot run. The review rules now ask for three compared options too.
- **Setup cleans up any earlier code-search tool, not one named tool.** When FindWright is picked, `/bindwright:setup` asks whether an earlier code-search tool is still set up, shows the search hooks and servers that may belong to one, and offers to take out the one the user names, whatever the tool, and `/bindwright:remove` leaves any such program installed. A project whose saved answers name a tool setup no longer offers keeps working as a custom tool.
- **A feature that needs a tool either gets it or stays off.** Setup checks the programs the size check, the mods and FindWright need (Python; Node and a newer CLI; a newer Node) once its helper is ready and before it asks anything, for the features that can still be on in the run. A yes installs it and asks for a restart before anything is saved; a no turns those features off and skips their questions, and a no for a computer choice stays until `/bindwright:setup global` changes it, instead of writing a check that fails on every run or quietly using the built-in search. Lizard, the size check's Python tool, installs in the same run when the size check is picked.

### Fixed

- `/close-session`'s count of code searches counts four kinds of repo search it left out, which made the hit rate look better than it was: a `git grep` with an exclude pathspec (`':!*.md'`, `:(exclude)`), a search naming a code folder beside a wildcard (`grep -rn foo *.md engine/`), a search after Bash's `cd "~/..."`, whose quoted `~` Bash leaves as a folder name (a PowerShell cmdlet still reads it as home), and an `rg` naming a code file beside a docs filter, since ripgrep searches a named file whatever `-t` or `-g` says. A wildcard is judged by its name, never expanded, and one with no extension (`docs/*`) by its folder, so `grep -rn foo docs/*` reads only docs and is not counted.
- `/bindwright:update` says how to land an update that adds the deep review's pin lookup and new action pins together: the deep review on that PR runs the base branch's workflow, which cannot check them yet, so the new pins go back to their tags and land in a second PR.
- The anonymous review counts and the once-a-day notice save their state files on Windows even while another process has the file open: the swap is retried for up to half a second instead of failing, and two writers never share a temporary file.
- **A plan limit that resets early ends its pause.** After a banked or early reset, the usage-guard mod's pause, active or cancelled, held until the old reset time, so the tasks mod's keep-going prompt stayed silent all that while. A pause now ends as soon as every limit it paused for reads under the wrap-up line in a new window: an active one resumes each paused session at its next minute check, and a cancelled one stays cancelled and stops holding without resuming them.
- FindWright, and `/close-session`'s hit rate, ask for Node 22.16 or later on the 22 line, or 24 or later, which its full-text index needs; Node 22.13 to 22.15 used to count as enough and then failed to build the index.
- **A new repo's first setup PR can merge.** It used to target `develop` and could never pass the review gate: the gate's files and the review workflow were not on the default branch yet, and `setup-review-gate.sh` had already required the gate there. The script now creates and repairs no ruleset while the default branch lacks `.github/scripts/review_gate.py`, stops on a read that fails for any other reason than "not found", and names a ruleset that already requires the gate. `review-tiers.md` § "The first setup PR" says the PR targets the default branch, merges on two local reviews, then cascades into `develop` before the branch rules go on, and setup's finish points to it.
- The layout check waits up to 90 s, not 30 s, for the browser's first start, which a fresh CI runner can take over 30 s for; the wait still ends as soon as the browser is listening (#847).
- The pack's directory check refuses a skill whose first line starts with `---` but is not exactly `---` (a BOM before it, or any whitespace, lone CR or Unicode space after it), which it used to skip (#847).
- The review workflows bring Node 22.23.5, a security release, instead of 22.23.4, on a self-hosted Linux runner without its own Node; the download is still checked against pinned SHA-256 sums.

## [v4.0.0] — 2026-11-12

### Breaking

- **The attribution guard reads commands with a real shell parser** (#821). Bindwright's helper now carries tree-sitter's bash and PowerShell grammars (`helper/parsers/`, copied unchanged with their versions and checksums), and the guard reads each command's body flags as the shell reads them: every command's, a wrapper's (`env`, `sudo`, `xargs`) included, except a text tool's (`awk -F,`, `cut -d@`, `grep -F word`), git's in a read such as `git log -F` (any other subcommand, an alias included, is read as a write) and gh's `--template`. Quoted text, here-docs and the value of `-m`, `--body` or `--title` are text, not flags, so the hand-rolled quote and stage scan, which nested quotes, PowerShell's `--%` and typographic quotes could mislead into skipping a real body file, is gone. A relative body file is read in the start folder and in every folder a `cd`, `pushd`, `Set-Location` or `git -C` in the command names, each reached from the folders named before it, since a `cd` may run in a child shell or fail. One after a folder change the guard cannot place (`cd -`, a target built at run time, a folder this computer cannot find) is refused, and so is a body file named by text built at run time (`"$HOME/body.md"`). A command the parser is unsure of (a program built at run time such as `$GIT`, a bash array, the text after PowerShell's `--%`, syntax it cannot read) gets the strict read described next, so flag-like text in its message (`$GIT commit -m "--file=x"`) is refused there too. **Act on it:** the parser runs on Node 18 or later. Without Node, or before `/bindwright:update` installs the new helper, the guard uses the strict read: every file flag in the command text, a text tool's and one inside quoted text or a here-doc included, so `git tag --list | awk -F.` is refused there, and a relative body file after any `cd`, `pushd`, `Set-Location` or `git -C` is refused, so name body files by absolute path there. Install Node 18 or later on a Python-only computer.
- **`/bindwright:runners` is now `/bindwright:local-runners`** (#831). The skill's bare name took `/runners` from the runners mod, so the CLI refused the mod's own command at session start and its row never showed. **Act on it:** type `/bindwright:local-runners` to set up local CI runners; `/runners` is the mod's command again.

### Changed

- **The step back comes sooner each time a PR stays red.** The review rules and the ci-watch mod ask for research and a simpler design after 3 red rounds in a row, then after 2 more, then after every red round from the 6th, instead of every 3rd round. `/ci-watch rounds` shows when the next one is due.

### Fixed

- The deep review's pin lookup verifies a pin only when nothing but a comment follows the commit id and no part of the action's path is `.` or `..`, so `o/r@<id> x` and `o/r/../x@<id>` are no longer reported as verified.
- The deep review's brief puts the request that asked for it last, after the pin lookups and the review guide's pointer, and the prompt says everything after the request line is the request's own text, so a request that imitates a lookup's "verified" line cannot pass a pin as looked up.
- The weekly pin check lists an action whose commit id has text glued after it (`o/r@<id>#x`), since YAML reads that as one ref that is not the commit.

## [v3.6.0] — 2026-11-12

### Added

- `/bindwright:update` lists the project's own files that still name the Bindwright version it was bound with, when it moves to a newer one; it never edits them (#814).
- **Every project's `git.md` says how to size a release.** A new `## Versioning` section: a major when users must act or something they use stops working, a minor for features and kept-working default changes, a patch for fixes only; a release tool that sets the version is fed, never bypassed; otherwise every version file is bumped together and the tag follows the existing style. `/bindwright:update` brings it to existing projects (#805).
- **Bindwright sizes its own releases by a written rule.** `CONTRIBUTING.md` § Versioning: a change a user must act on goes under `### Breaking` and makes a major, features and kept-working default changes a minor, fixes only a patch. Release prep reads every entry against it first, and a test checks each release from v3.5.0 on (#805).
- **The deep review gets each new action pin looked up on GitHub** (#819). Its reviewer's tools cannot reach other repos, so a PR that pinned actions by commit was blocked on provenance it could not check, with no defect found. The deep review workflow now looks up the release tags each added pin's comment names (`# v6 (v6.1.0)`) and puts which of them point to the pinned commit in the reviewer's brief, using the base branch's `pin_check.py added`. A failed lookup leaves the result out and never fails the review.

### Fixed

- `review-tiers.md`'s gate recovery restores the PR's own base branch with `setup-review-gate.sh --branch <base>`; the script's defaults (the default branch and `develop`) left out `main` where `develop` is the default branch.
- The attribution guard reads an escaped quote outside quotes as a literal, so the shell's apostrophe idiom (`'it'\''s done'`) no longer throws its quote pairing out of step and makes a later `--body-file` look like quoted text, and a `$'...'` string reads its backslash escapes the way bash does; every release through v3.5.0 skipped that file (#816).
- `/close-session` and `review-tiers.md` merge once every check has settled and the required ones pass, not as soon as the required ones do (#814).
- `/bindwright:update` makes sure `.gitignore` lists `.claude/settings.local.json`, the personal file that holds the allow list and each person's own switches, and offers `git rm --cached` when a repo has it committed, warning that every other clone loses its copy when it pulls that commit. Setup already did the first; a repo set up before it, or one whose `.gitignore` lost the line, could commit the file with everything added to it (#809).
- The deep review's first API call, which reads the PR's head and base commits, tries three times and takes only two commit ids as an answer, so one bad reply from GitHub no longer ends the review.

## [v3.5.0] — 2026-11-12

v3.5.0 pins every workflow action to a commit, makes the attribution guard stop refusing ordinary commands, reads a repo's default branch at setup, and fixes how the session-close search count reads a command.

v3.3.0 should have been a major release: it renamed `/session-start` and `/session-close` without keeping the old names, replaced tokensave with FindWright, and removed the `architecture-graph` template. `/bindwright:update` moves a project across, but anything outside the project that typed or named the old commands needs the new ones. Releases from here on follow a written versioning rule (#805).

### Changed

- **Every workflow action is pinned to a commit** (#800, #801). The templates and the live workflows name each action by its commit, with the release in a comment, so a moved tag can never change what a run executes. The weekly pin check also lists any action a workflow uses by a tag or branch, a `docker://` image without a digest included, and keeps its issue open until every one is pinned.
- **A trunk-based project's review runs on `main` alone** (#801). The review workflow's branch list no longer names a development branch the project does not have.
- **The merge waits on every required check** (#803). `review-tiers.md` and `/close-session` merge once the `Review gate` is 🟢 and every other check the branch requires passes, not on the gate alone. The gate-recovery steps name each older check a project may require (`Evaluate review outcome`, and `Claude On-Demand` under `checks: two`), and put each back with the setup script's `--require`, confirmed with the same flags. A PR whose base branch changed starts no checks: the rule says to push a commit or close and reopen it.

### Fixed

- **The attribution guard reads every message file of a write and refuses nothing else** (#798). A file flag in a text tool's own stage (`awk -F`, `grep -F`, `sort`) is no longer read as a message file, while a flag on a continued line, after a `case` branch, inside backticks or after a `$( … )` group is read as before, and `git commit-tree` stays a write. `--field`, and a quoted `key=@"path with a space"`, are read too.
- **Setup reads the repo's default branch** (#799). When GitHub's default branch is `develop`, the rules say so (`"devIsDefault": true`); with a setup code it says when the code and the repo disagree.
- **`/start-session` and `/close-session` spell out the merge-in and cascade steps** (#799) instead of pointing at `git.md` sections an adopted project may not have. `/close-session` stages the session's files by name and leaves a file it did not change out of the commit, naming it in the last message.
- **The first offline close keeps `.bindwright/pending-tracker.md` out of every commit** (#799), as it does for the hand-off file.
- A slow mod test no longer fails the Windows runner at the default 5 s (#804).
- **The close-session search count judges a search by what it reads.** `research-adherence.py` takes a search's file filters (globs, types, `-Include`) when it has any, otherwise only the files and folders it names that exist on disk, and a folder by the files git tracks in it. A command with an option the script does not know is read as unsure and counts unless it runs outside the repo and names nothing inside it. Before, it scanned the whole command for doc words, so a pattern such as `"mod.json"`, an option value, a redirect or a comment could be read as a path or a doc, a negated glob (`!*.md`) as a doc search, and `docs/` as code; each left searches out of the count or counted docs as code (#791, #796).
- `/close-session` states the three status-update triggers itself, since a project's `tracker.md` may defer them to another file, and runs an extra close step marked *after the hand-off* last, so a board check or a public mirror reads the session's final state. `clean-code.md`'s issue-link exception names the issue's title where a project check bans issue numbers in code (#791).

## [v3.4.0] — 2026-11-11

v3.4.0 has a PR stop to rethink after 3 red review rounds instead of 6, and fixes the repo links in a bound README and issue form.

### Changed

- **A PR stops to rethink after 3 red review rounds, not 6.** `review-tiers.md` and `local-review.md` tell the session to research how others solved the problem and simplify after 3 red rounds in a row, and again at every 3rd, so a stuck PR changes course much sooner. The `ci-watch` mod asks for that step back on the same rounds (3, 6, 9, and so on). The review counts mark a PR as stalled at 3 red rounds, and the counter accepts them from 3 rounds per stalled PR; the page reads "took 3 rounds or more", and fixed PRs "1 or 2 rounds". Counts sent before this release used 6, so the page's stalled share grows as projects update. `/bindwright:update` brings the rule to existing projects.

### Fixed

- The bound README's clone command and the issue form's discussions link use the repo URL whole, as setup saves it; they read `https://github.com/https://github.com/...` before. A project with GitHub Actions but no AI review no longer gets a `git.md` pointer to `review-tiers.md`, a file it does not have (#788).

## [v3.3.1] — 2026-11-11

v3.3.1 fixes how `/bindwright:update` treats a project that owns a session skill under its old name.

### Fixed

- A project that lists `.claude/skills/session-close/SKILL.md` or `.claude/skills/session-start/SKILL.md` in `.bindwright/owned` keeps only its own copy, and the update keeps that file's base under the old name. Once the project removes the line, the next update moves its copy to the new name, edits included. The same holds when the claim covers both names, such as a `.claude/skills/` line. In v3.3.0 the update recorded the new name as written, so after the line was removed it reported the skill as deleted and never added it. A project that already ran v3.3.0's update with such a line runs one v3.3.1 update with the line still in place before removing it; the new skill is then added next to its own copy under the old name, which it moves or deletes by hand. A project that already removed the line under v3.3.0 sees the skill reported as deleted: copying its old skill file to the new name brings it back under the update.

## [v3.3.0] — 2026-11-11

v3.3.0 replaces tokensave with FindWright, an adaptive code index that ships inside the helper, lets per-project mods be switched off in one project, and renames the session skills to `/start-session` and `/close-session`.

### Added

- **Mods can be turned off for one project, and setup has a project part of its own** (#767). `ci-watch`, `tasks` and `skill-check` can be switched off in a single project while every other project keeps them: a project with no CI checks has nothing for `ci-watch` to watch. The switch is the CLI's own `enabledPlugins` setting in the project's personal `.claude/settings.local.json`; the other seven mods act for the whole computer and stay computer choices. A first `/bindwright:setup` now asks the computer choices, then offers to set up the current project. The new `/bindwright:setup project` asks the project questions plus which per-project mods run there, with `ci-watch` off by default where the project has no GitHub CI, and `/bindwright:join` asks the same. `/mods` marks the mods the current project turned off.
- **Setup suggests the merge for files a repo already has** (#661). A new engine command, `--propose-merge`, compares each staged file with the repo's copy and prints a suggestion without changing anything: for JSON settings the permission lists unioned, missing hooks appended and every clashing key listed with both values; for Markdown the sections to add, the ones that differ and the ones only the repo has. Setup's merge step, and `/bindwright:update` for files it has no earlier version of, read that suggestion against the repo, recommend a choice for each clash and save only after a yes.
- **`/bindwright:review-trial` compares models for the repo's AI review on its own history** (#732). It builds the cases from merged pull requests the review gate commented on, offers only the models the user's plan includes (a Fable candidate on Pro only after a yes, since it bills credits), shows how many reviews and judge runs it will start before anything runs, and recommends whether to change `.github/review-gate.yml`. A light run (4 pull requests, one round, one judge) is the default; the full best-of-three with two judges is an option.
- **The `runners` row flags data growth** (#728). It adds `+X GB in a week` when the data inside a WSL runner's disk grew by 5 GB or more over the last full week, which the gap-only `compact` hint missed. `/bindwright:runners` scopes its log pruning to each job's own runner, offers to prune the review jobs' package cache and old CLI versions in the runner account's home, and says how to register a runner again after the repo is renamed.
- **Session start says when the review counts are on but not going out** (#741). The notice names a repo whose last counts send failed, and when the helper is missing on a computer that turned the counts on, `/start-session` says so and points at `/bindwright:setup`, instead of skipping its check without a word.
- **The `runners` row says when a Start press failed** (#755). A Start command that cannot launch, exits non-zero or runs past its 30 seconds shows `start failed` on the row until the runners come up, instead of the row waiting on runners that never start.

### Changed

- **FindWright replaces tokensave as setup's code-search tool.** FindWright ships inside the helper, so nothing extra is installed: it indexes every file a project tracks (code, Markdown, config, templates), answers plain-English questions, names and regex searches, and keeps its index current on every call. Its meaning search uses a 32 MB static code model, downloaded once and checked against a pinned SHA-256, with no inference runtime. It needs Node 22.13 or later. A project whose saved answers name tokensave keeps working as a custom tool until it picks FindWright, and setup offers to take tokensave's hook and server out. A setup code from the page that names tokensave is refused, like codes naming earlier removed tools: make a new one.
- **The session skills are `/start-session` and `/close-session`** (#774). With the verb first, `/st` and `/cl` complete them; the shared `session-` prefix needed nearly the whole name. `/bindwright:update` moves a project's two skill files to the new names with its own edits merged in, and reports them under `renamed`. `usage-guard` still runs `/session-close` in a project not updated yet, and its notices name both commands. A `skill-contracts.json` made from the old example names the skills by their old names, so rename its two keys.
- **`/bindwright:review-trial` and `/bindwright:runners` run only when typed** (#765). The first spends model time and the second installs software, so neither starts unless the user asks, and their descriptions no longer sit in every session's context. `/bindwright:doctor` and `/bindwright:report` can still be started by the session when something breaks.
- **The guard hooks block a command when they crash or time out** (#679). The attribution and push guards set Claude Code's `onFailure: block` (CLI 2.1.295+): a guard that crashes, times out or exits with a code other than 0 or 2 blocks the command instead of letting it through. A repo whose setup was removed or half-installed (no launcher, hook file or Python) still lets commands through, with an explicit exit 0. A guard in `~/.claude` whose Python was removed cannot start, so it blocks every shell command, setup's included, until that Python is back or its entry is deleted from `~/.claude/settings.json` in a text editor. `/bindwright:update` brings the change to existing projects; the guards in `~/.claude` get it on their next install.

### Removed

- **The `architecture-graph` skill template** (#769). No setup has shipped it since v2.0.0, so the template, its entry in the engine's file list and the lines that kept it out of every setup are gone. The architecture pattern rules stay.

### Fixed

- **The review gate finds the routine review whatever the case of its heading** (#716). A review headed `## code review — My-Repo` was read as missing and spent the next attempt. `review-tiers.md` also says how the maintainer recovers when a broken gate script or gate settings file lands on a protected branch, and the runners guide says what the review loses when a Linux runner cannot download Node.

## [v3.2.0] — 2026-11-10

v3.2.0 moves the review tiers to Fable 5.2, names every session after its project from one computer-wide setting, and lets self-hosted runners without a Linux Node run the reviews in full.

### Changed

- **The review tiers move to Fable 5.2.** The routine review runs `claude-fable-5-2` at low effort and the deep review `claude-fable-5-2` at medium, both with the same `claude-opus-5-5` high backup. In a best-of-three, head-to-head trial against Fable 5.1 low on saved pull requests with known findings, scored by a two-judge panel, both settings missed fewer known defects for less money; the deep setting lists more findings the judges ruled out. Existing binds keep their pins until `/bindwright:update` or an edit to `.github/review-gate.yml`.
- **Session titles move to the computer setup, for every project.** The `session-title` hook is now a global extra in `~/.claude`, asked once per computer: every session is named after its project (the name setup saved, else the repo's folder), then `<Project> - <purpose>`, in projects Bindwright never set up too. Its files live in `~/.bindwright/session-titles/` instead of each repo's `.bindwright/sessions/`, with an allow rule so the purpose is written without a prompt, and `/session-start` writes the purpose to the file the hook names. Binds no longer write the project copy of the hook.
- **The `runners` mod's WSL disk figure stays current and shows real use.** While the runners run, the data inside the distro is read at most once a minute and the disk file every 15 minutes (both right after a start, the file after a stop), instead of hourly. The file's size is its allocated bytes, so a sparse disk shows what it takes on the host, and its hint reads `trim` (an `fstrim` inside the distro, no shutdown) instead of `compact`. The reading is shared by every session on the computer through the mod's store.

### Fixed

- **The review jobs install their CLI on self-hosted runners with no Linux Node** (#714). On a WSL runner whose only `npm` was the Windows one, the install left no Linux binary, so the review ran without its credits run and its backup. Each review job now downloads the official Node build into its temp folder when the runner has no Linux Node 22 or newer, checks it against a pinned checksum, and uses it only for the install.
- **The session-close count of code searches no longer reads a shell redirect as a path** (#733). A search of a folder outside the repo that ended in `2>/dev/null` counted as a plain search of the repo's code.

## [v3.1.0] — 2026-11-09

v3.1.0 fits Bindwright to projects the team does not fully control: a local review before each merge where no CI can run the AI reviews, the assistant's files kept off a client's or employer's repo, and required reviewers who must approve each pull request.

### Added

- A local review gate for projects where no CI can run the AI reviews (GitHub with apps and Actions blocked, or another site): setup offers it, off unless picked (`"localReview": true`), and `.claude/rules/local-review.md` has the session run two fresh reviewers on each change before it merges, with the CI reviews' bar and verdict rule. Nothing about the review is posted to the host.
- For someone else's project, setup asks whether to keep the assistant's files on this computer only. On a yes (`"localOnly": true`), `CLAUDE.md`, `.claude/`, `.bindwright/` and its other files for the assistant go into the clone's `.git/info/exclude`, never `.gitignore`, before any file is written, and the files meant for the whole team are offered one by one to keep or drop. A new engine command, `--local-exclude`, writes that list, and `/bindwright:update` refreshes it.
- A team project on GitHub can name required reviewers, people or `<org>/<team>`, with the new `prReviewers` setup answer: each pull request requests them, and the session merges only once GitHub reports the PR approved, waiting while a review is still owed or changes were asked for.

## [v3.0.1] — 2026-11-09

v3.0.1 lets the plugin directory accept Bindwright: the plugin no longer ships a file the directory refuses.

### Fixed

- The plugin no longer carries a `VERSION` file, which the plugin directory refuses from an organization that is not Verified because it has no allowed extension. The skills and the session-start notice read the plugin's version from its manifest, `.claude-plugin/plugin.json`, and the directory check refuses an extensionless file other than a license or `.gitignore`.

## [v3.0.0] — 2026-11-09

v3.0.0 gets Bindwright into the plugin directory: the plugin is now skills only, and everything that runs on your computer installs as a helper pinned by the plugin, after your yes. It also titles sessions after the project, sums up what changed when you update, and takes Bindwright back out cleanly with `/bindwright:remove`.

### Added

- Sessions in a set-up repo are titled after the project, then `<Project> - <purpose>` once `/session-start`'s plan is approved, instead of the CLI's title from the first message, so several sessions and their peer lists tell projects and tasks apart. A new project hook, `session-title.py`, sets each title once, so one picked with `/rename` stays until the purpose changes.
- `/bindwright:update` opens with a plain summary of every release since the version the repo was set up with, newest first: what is new, changed and fixed, and what the user may want to act on. A new engine command, `--releases-since`, reads the plugin's own changelog, which ships in the helper.
- `/bindwright:remove` takes Bindwright back out: the files setup wrote into a repo, except those the user changed or marked as the project's own, only setup's parts of shared files such as `CLAUDE.md`, the extras it added to the config folder (hooks, mods, the builder agent, the reply style), and finally the plugin itself. Two engine commands back it, `--remove-plan` and `--remove-files`, and `home.py` gains `remove-mod`, `remove-agent` and `remove-style`.

### Changed

- **Breaking:** the plugin now holds only skills, its manifest, icon, README and version, which is what the plugin directory accepts from an organization that is not Verified, so Bindwright can be installed from the directory. Everything that runs on the user's computer (both engines, the templates, the config-folder extras and mods, and the counts, layout check, notice and runner scripts) ships as the helper: two files attached to each GitHub release, one npm installs and one pip installs for computers with Python and no Node, built by the release workflow from the tag. Setup installs it on a yes, only when the download matches the SHA-256 the plugin pins in its `helper.json`, into `~/.bindwright/helper` for the user only, with no admin rights and no install scripts; `/bindwright:update` keeps it at the plugin's version, the session-start notice says when it falls behind, the doctor checks it, and `/bindwright:remove` deletes it. The rules a set-up repo gets run the counts send and the layout check from the helper; run `/bindwright:update` in each set-up repo after updating the plugin.
- The anonymous review counts, for a computer that turned them on, also send after each pull request the session merges, not only at session start, so a session open for days keeps the page current. Every trigger checks one saved time, the last send plus 24 hours, in place of the once-per-calendar-day check, so sends stay a steady day apart in any time zone.

### Fixed

- Setup installs lizard, which the size check needs, on a Python that refuses `pip install --user` because the system or Homebrew manages it (macOS with Homebrew, Debian, Ubuntu): it installs it into its own environment at `~/.bindwright/size-check-venv`, and the size check looks there too.
- The layout check no longer stops at random on Windows with `EBUSY` while the browser starts: it waits while the browser still holds its DevTools port file locked.

## [v2.4.0] — 2026-11-08

v2.4.0 lets setup finish on a fresh machine, stops the layout check from leaving browsers running, and shows on the page how many pull requests merged and skipped the AI review.

### Added

- The page's review results show how many pull requests merged and how many skipped the AI review, beside how many passed it on the first try, were fixed in 1 to 5 rounds, or needed deeper research: as totals, and under each project's bar with its exact counts.

### Fixed

- Setup no longer stops at its last step, removing its staging folders, which the project's own settings refuse as `rm -rf`. A new engine command, `--clean-staging`, removes only `.bindwright/incoming/` and `.bindwright/global/` and refuses a folder that is a link; `/bindwright:update` uses it too.
- Setup asks about installing lizard, which the size check needs, at the start with the other requirements instead of partway through, and on Windows checks that Git is Git for Windows, whose shell runs the guard hooks.
- The layout check no longer leaves headless browsers running. On Windows, Edge's launcher exits at once and hands off to the real browser, which only a clean finish used to close: the check now stops the browser itself, on a stop signal too, and each run first stops browsers that runs killed outright left behind.
- A team project without the AI reviews, on another site or on GitHub with them off, no longer reads in the collaboration rule that a 🔴 review verdict blocks its merge: a failing check or a reviewer's requested change does.

## [v2.3.0] — 2026-11-06

v2.3.0 sets up projects on GitHub whose organization blocks GitHub apps, Actions and boards.

### Added

- Setup has a fourth answer for where the code lives: GitHub, but the organization, job or client blocks GitHub apps, Actions and project boards. The project keeps branches, pull requests and issues, gets no workflow, review gate or board, and its rules run the tests and the size check on the computer before each push instead of counting on CI. When the organization blocks the GitHub CLI's sign-in too, the rules hand each pull request step to the user on GitHub's web page, with the title and body ready to paste.

### Fixed

- The `ci-watch` mod ends a watch without waking the session when the pull request still shows no check after ten minutes and the repo has no workflows. It used to wait an hour for checks that never come and then wake the session. Checks from outside Actions, such as commit statuses from another CI, are watched as before.
- A team project set up without the AI reviews no longer reads, in `CONTRIBUTING.md` and the collaboration rule, that an AI review verdict gates every merge.

## [v2.2.3] — 2026-11-06

v2.2.3 completes the plugin's directory listing.

### Changed

- The plugin names its documentation, support page, privacy policy and terms of service, which the plugin directory shows on its listing.

## [v2.2.2] — 2026-11-05

v2.2.2 takes the last download-and-run command out of the shipped review workflows, for the plugin directory's checks.

### Changed

- The review workflows install the CLI from npm, at the exact version npm's `latest` channel (or `stable`, for the backup) names, instead of piping the install script into a shell. A self-hosted runner needs Node 22 or newer for that; without it the review runs on the action's own CLI. npm runs in global mode, so a `.npmrc` in a PR cannot choose the version or the registry of its own review. Any failure still falls back to the action's own CLI.

## [v2.2.1] — 2026-11-05

v2.2.1 gets the plugin ready for the plugin directory's checks: it declares no hooks, and the daily notice runs from `/session-start` instead. It also fixes when the bundled usage-guard mod compacts and wraps up, and where the budgets row reads the wrap-up level.

### Changed

- The plugin declares no hooks. The daily notice that the plugin or the repo's Bindwright files are behind, and the opt-in review counts send it starts, now run when a session starts with `/session-start`, which every setup writes; a plugin installed from the plugin directory updates through Claude Code's plugin auto-update, which an install from Bindwright's own marketplace link gets once it is turned on for that marketplace in `/plugin`. A repo set up with v2.2.0 or earlier gets that step once `/bindwright:update` runs in it; until then it shows no notice and sends no counts.
- The review counts read only the one setting that names a local counter, not the whole environment.

### Fixed

- usage-guard compares the context fill with "Compact before a pause above" unrounded, so a fill just under the setting no longer compacts. The setting's default is 35%, and the wrap-up default is 95%.
- session-facts reads the wrap-up level from usage-guard's settings file first, with the same check usage-guard uses, so the plan chips turn red where usage-guard wraps up.

## [v2.2.0] — 2026-11-05

v2.2.0 opens Bindwright to people new to programming: setup works for a project without GitHub, says in plain words which tools are missing and how to get them, and installs with one command, with no Git and from the Claude desktop app. It also gets the plugin ready for the plugin directory and makes each review tier post exactly one verdict, checked by the gate's reader before it is posted.

### Added

- **Setup for a project without GitHub** (#631, #633). Setup first asks where the code lives: GitHub, just this computer, or another site (GitLab, Bitbucket and the like), saved as `advanced.codeHost` (`github`, the default, `local` or `other`). For `local` and `other` the AI reviews are off and the work state lives in the hand-off file; no board, private tracker repo, public roadmap, `.github/` workflows, issue and PR templates or review settings are written, and both engines refuse answers that need GitHub. A just-this-computer project is one person's: `git.md` gets a "Save points" section in plain words instead of branches and pull requests, and the other shipped files drop their branch, CI, push and pull-request steps. Another site gets `.claude/rules/code-host.md`, which says how to read each GitHub step there and lists the GitHub-only parts left out. Answers saved before this release read as `github`.

- **Plain words for first-time users** (#633). With no Git name or GitHub sign-in, setup asks "Have you used Git and GitHub before?"; "Not really" words the rest plainly and recommends the safe answers, and setup sets the Git name and email on a yes when they are missing.

- **Setup says what is missing and how to get it** (#627, #630). Setup checks for Git before it looks for the repo and stops with a plain explanation when Git is missing or neither Node 18 nor Python 3.8 is there, with the install route for the user's system: winget on Windows and `xcode-select` on macOS, both offered to run on a yes, and on Linux the package-manager command to run yourself.

- **The packed plugin on its own branch** (#421). Each published release also writes the packed plugin to a `plugin` branch, the layout the plugin directory installs from, and the plugin gains an icon and an install line for its listing.

- **Where session scratch goes** (#531). `token-efficiency.md` asks every session to keep scratch files, test copies and captures in its scratchpad or the project's git-ignored build folder, never a fixed folder such as `C:/tmp`, since the CLI deletes a session's scratchpad with its transcript after `cleanupPeriodDays`.

### Changed

- **Install with one command, with no Git, and from the desktop app** (#631). The install command adds the marketplace from its address on the project's site, so installing needs no Git, and the page's Install section switches its steps between the CLI and the desktop app, where `/plugin` does not run: there a line pasted into the chat installs the plugin.

### Fixed

- **The routine review posts from a job apart from its reviewers** (#456, #460). The review attempts run with a read-only job token, and a second job checks the review again with the gate's reader and posts it, so no reviewer process shares a job whose token can write checks. A run whose PR has a newer head posts nothing, a deep-review request with automatic escalation off is posted only when one is owed, every GitHub call in the repair step has a time limit, and the CLI installs into a home folder of the job's own.

- **The deep review posts once, after every attempt** (#458, #628). The deep attempts post nothing: each returns its review as structured output, the workflow checks it with the gate's reader, and one step posts the first readable review as the review app. A crashed, hung or late attempt can no longer leave a second verdict that buries the first, and a run whose PR has a newer head posts nothing.

## [v2.1.0] — 2026-11-05

v2.1.0 adds two computer choices to setup (a plain reply style and the work language), opt-in review counts from real projects that feed the page's evidence, a helper that sets up local CI runners, and a layout check for visual work. It also fixes how the bundled mods follow a `/clear`, and closes gaps in the review gate and the two engines.

### Added

- **A plain reply style** (#532). Setup asks once per computer whether to install `straight-talk`, an output style that keeps chat replies short and plain, the answer first; `home.py add-style` copies it into `~/.claude/output-styles/` and turns it on, and keeps a copy the user already edited. `/output-style default` turns it off.

- **The work language** (#522). Setup asks once per computer which language the user works in, English or Spanish. For Spanish, `home.py set-language` sets the CLI's `language` setting, so replies come in Spanish, and writes `~/.claude/rules/work-language.md`, asking for commit messages and code comments in Spanish unless a project's own rules name a language. The setup's own files stay in English. The settings page lists the new row.

- **Opt-in review counts** (#551). Asked once per computer and off unless the user says yes: each day, each set-up project the user picks sends six numbers about the user's own merged pull requests (reviewed, caught, deep reviews, held back six or more rounds, merged, red rounds) under a random id, with no names, code or links. Past pull requests are counted in daily batches. A Cloudflare Worker keeps the totals, and the page's evidence section reads them.

- **A runner setup helper** (#586). `/bindwright:runners` measures how long recent jobs waited and how many ran at once, recommends how many local runners the machine can take, and walks through installing them. The runners mod shows the WSL disk file against the data in it and suggests compacting past a 10 GB gap (#581).

- **A layout check for visual jobs** (#553). `plugin/hooks/layout-check.mjs` opens a page headless at phone and desktop width and fails on overlapping elements, text that overflows its box and sideways scroll; the builder agent's brief runs it on every job that changes a page.

- **A doctor check for hook programs** (#530). `/bindwright:doctor` reports a global hook whose program is no longer on the computer, and setup writes `python3` or `python` for the hook launchers when the PATH finds that same interpreter, so a moved Python install no longer breaks every hook.

### Changed

- **The board without the hand-off note** (#493). Setup offers a GitHub board on its own, with the hand-off note as a separate choice.

- **The page** shows its sections open, keeps one terminal size, and sets the mods side by side.

- **The review workflow templates** match the review action pinned at v1.0.266, and their pin update notes are corrected (#410, #598).

### Fixed

- **Mods after a `/clear`** (#618, #622). The tasks panel shows the new session's list and carries the last session's unfinished tasks over at its first prompt; ci-watch keeps polling its watched pull requests and wakes the session when they settle.

- **A shared-PC seat claim under contention** (#607). A claim keeps waiting while the lock changes hands, and gives up only when one holder keeps it for 10 s or after 15 s in all, inside the time the mod's hooks give one call.

- **An oversized message in the compaction hand-off** (#591) is cut to the hand-off's budget instead of crowding out the rest.

- **The review gate's verdict window** (#433, #434) is taken from GitHub's clock for both tiers, and the gate fails with a clear reason when its checkout fails.

- **The two engines** refuse writes through a linked parent folder (#467), word unreadable files and huge numbers alike (#471), and refuse answers they would export differently (#473).

- **The research count** skips searches outside the repo (#462), and two misleading lines in shipped files are corrected (#345).

## [v2.0.0] — 2026-11-04 — Bindwright

v2.0.0 renames the project to **Bindwright** and replaces the v1 configurator with a Claude Code plugin. `/bindwright:setup` asks a few questions in the session (computer questions once, project questions in every project) and writes the setup through one bind engine with JavaScript and Python twins; `/bindwright:update` keeps it current with a three-way merge that never overwrites hand edits. The site is a landing page with the install steps, every setting and its default, a comparison, and the review results from real projects. The plugin installs from this repo's own marketplace.

### Added

- **Release project files** (#342). `SECURITY.md` (private reports through GitHub, what is in scope), `CODE_OF_CONDUCT.md` (the Contributor Covenant 2.1), `LICENSE-MIT-0` for the files setup writes into a project, and a notice that Bindwright is not made by, endorsed by or affiliated with Anthropic.

- **A private repo for the work items** (#540). `advanced.trackerRepo` names a private repo that holds the issues when the code repo is public, since a public repo's issues are public whatever the board's setting. `tracker.md` adds `--repo` to its issue commands and filters the board by that repo, PR bodies link its issues by full name, the public roadmap script reads the private items from it, and setup offers it whenever the code is public. It can never be the public roadmap repo. `/bindwright:update` and the doctor fill in the default for any answer a project saved before that answer existed, so older projects keep working.

- **A warning whenever the full-detail board is public** (#538). `tracker.md` now checks the board's visibility before every board read and, when it is public, opens the reply with a plain warning and the command that makes it private again, since a board can be made public on GitHub without going through setup. `/bindwright:doctor` lists it as its most serious finding.

- **Setup asks its own questions** (#534). `/bindwright:setup` needs no setup code: it asks about the project on every run (who works on it, whose it is, private or public, AI credit in commits, which checks run, how the assistant works) and about the computer only the first time (the code-search tool, global instructions, a push guard for every project, the mods), saving those in the personal settings layer. It also asks where the work state lives (a GitHub board with a short hand-off note, issues only, or a detailed hand-off file), creates the board, and asks whether to keep it private, add a clean public copy, or, after a plain warning, publish it in full. Every setup ends by listing the computer choices and where to change them; `/bindwright:setup global` asks them again. A `bw1-` setup code still works. The engine fills in the defaults for answers given on standard input, as it does for a setup code.

- **An optional public roadmap** (#494). With the `github` tracker, `advanced.publicRoadmap` (off by default) names a public repo, and `.github/scripts/public_roadmap.py` mirrors into it only the issues whose body has a `### Public summary` section, under the same numbers, with the title and that section and nothing else. `check` lists text that would leak: brackets and angle brackets (links, images and HTML need them), code, file paths, pull request and branch references, identifiers, tuning constants, links to private issues, names from the settings file's `hidden` list (its `allowed` list lets public words such as `iOS` or `Node.js` through), and wording about AI models or code review. `push` refuses while `check` reports anything, then creates, edits, closes, reopens and links the public items, copies chosen board fields, and withdraws an item whose summary was removed. `tracker.md` gains the rule, and `/session-close` runs it after the issues are updated.

- **A clean-code rule and a comment audit method** (#497). `clean-code.md` sets the readability bar for code files: comments say what the code does now, one line by default, with no history, planning codes or dates; names are spelled out; one job per function; no copies; match the file. The review guide blocks a breach. `docs/comment-audit.md` trims the comments of existing code area by area, with a check that the code itself stays the same.

- **A doc-currency check at session close, and a drift audit** (#498). `/session-close` now searches the living docs for every name, path, command and number the session's diff changed, and fixes claims that no longer hold. `docs/docs-audit.md` is the full sweep for stale docs, comments that contradict code, rule breaches and size limits: fixed in area batches, with cross-area fixes on a tracked list and false positives recorded with their reason.

- **A security rule and posture template** (#495). Every setup ships `.claude/rules/security.md`: nothing secret ships, every shipped artifact is assumed readable, reverse engineering included, secrets live server-side or in the platform's secret store, a leaked secret is rotated first, and downloads and plugins are parsed as untrusted input. `docs/security-posture.md` is the fill-in record it points to: threats ranked by cost, a credential inventory, account hardening, what ships in each build, export-time hardening and download trust boundaries.

- **`/bindwright:audit`** (#420). A new plugin skill measures how the repo's rules held up in its recent Claude Code sessions, from the logs the CLI keeps under `~/.claude/projects/`, and proposes exact edits to the rules that did not hold, each applied only on a yes. The engine (`engine/audit.js` and its Python twin, run as `cli.js --audit` or `bind.py --audit`) reads the newest 50 sessions with their subagents, counts a call copied into a resumed or forked session once, and checks five rules where the repo has them: the commit message format, the attribution guard's blocks, the code-research tool against Grep and Glob, a task list in sessions with three or more edits, and `gh run watch`. Each check reports how often the rule applied, how often it broke, and up to three examples. A command counts only where it starts a line or follows `;`, `&`, `|` or `(` outside quotes, so a search or message that merely names it does not. It leaves outdated advice, stale paths and contradictions to the built-in `/doctor prompt-audit`.

- **A bar every test must clear, and a way to audit a suite against it** (#496). `testing.md` opens with when a test earns its place: it guards something a user would notice or a hard contract, fails for one reason (near copies fold into one table of named rows), and checks outcomes, never internals. Mutant checks are kept only for a formula that already broke once or for codecs, fixed-point math and determinism, seeded sweeps only where no table can list the input, and benchmarks stay out of the pass or fail suite. The review guide blocks a new test that misses the first three. `docs/test-audit.md` is the audit method: scan per rule, then list A (mutant checks kept only when the old version was real), list B (fold only same-shape tests, every row named and traced) and list C (keep sweeps that reach input no table can list), landed in small PRs with the suite green.

- **A hand-off file beside the board, and one roadmap that stays true** (#493, part 1). With the GitHub tracker, `/session-close` now also rewrites `.bindwright/handoff.md`: about ten lines that point at the issues the session worked on and the one to start with, kept out of git through git's local exclude file (`git rev-parse --git-path info/exclude`), and `/session-start` reads it first (`handoffFile`, on by default). With the file tracker, the hand-off file is joined by one `ROADMAP.md` in place of module roadmaps: Now, Next and Later, one line per item with an id, finished items moved to `CHANGELOG.md`, and `/session-start` flags any Now item whose branch is merged or gone.

- **Setup reads the CLI version the session runs** (#422). Before offering the mods, `/bindwright:setup` and `/bindwright:join` take the version from the session's `AI_AGENT` variable instead of `claude --version`, since the desktop app runs its own copy of the CLI, which can be older than the one on the PATH. Skipped mods come with a one-line reason, and setup says in one line why the built-in "You should know" mod stays off.

- **`/bindwright:report`** (#470, part 2). Files a bug against Bindwright the way the CLI's own feedback command does: it drafts the report from what failed and the doctor's findings, the engine (`--report`, `engine/report.js` and its Python twin) replaces the repo path, home folder, user name, emails and tokens with placeholders, and the skill shows the whole report and files it with `gh` only on a yes, or hands over a prefilled new-issue link. Setup, update and the doctor offer it when the engine fails.

- **`/bindwright:doctor`** (#470, part 1). A read-only health check of a set-up repo and this machine that says what is wrong in plain words and how to fix each thing: broken or missing setup files, a repo older than the plugin, missing guard hooks, staged files still waiting, settings the layers ignore, extras the project expects, and a CLI too old for the installed mods. It reads the version of the CLI the session actually runs, so Claude Desktop's own copy is caught too. It also runs the review gate's `--check`.

- **A Bindwright marketplace, served from GitHub releases** (#421, part 1). `tools/pack_plugin.py --zip FILE` builds the plugin's release zip from the files git stores at a ref, not from the working tree, so every machine gets the same bytes whatever its line endings, and `--marketplace` writes `.claude-plugin/marketplace.json`: one `bindwright` entry whose `archive` source is that release's zip, pinned by its SHA-256. The plugin folder gains the `README.md` the plugin directory asks for. Users add the marketplace with `/plugin marketplace add starfoxcom/claude-code-templates` once the first release carries it.

- **The daily notice reports setup drift** (#419, part 3). When the repo's shared setup rates an extra `required` or `recommended` that this machine lacks and nobody declined, the once-a-day notice names it and points at `/bindwright:join`. The packed engine's `runSettings` decides, so the notice and join never disagree; any error leaves the line out.

- **`/bindwright:export` and `/bindwright:join`** (#419, part 2). Export records which `~/.claude` extras the project requires or recommends, and which settings no one may override, in `.bindwright/project.json`. Join, on a teammate's machine, checks tracker access, the code-research tool and each missing extra with a yes or no, remembers every answer in the person's own settings layer, and ends by starting the session. The engine writes both through `--export` and `--remember` (`engine/share.js` and its Python twin), refusing any value the layers would ignore and any write through a symbolic link.

- **Settings layers** (#419, part 1). `engine/layers.js` and its Python twin resolve Bindwright's settings from three layers: personal (`~/.claude/bindwright/settings.json`), the project (`.bindwright/project.json`, whose new optional `setup` object rates extras as required or recommended and lists the settings no one may override) and personal-in-this-project (`.bindwright/local.json`). `cli.js --settings DIR` and `bind.py --settings DIR` print the result with the extras this machine has and the drift between them. Files are data only: unknown keys and bad values are listed and never applied, and a file from a newer schema is refused. The format is in `docs/v2/HANDOFF.md`.

- **Daily update notice** (#418). The plugin's first hook, `plugin/hooks/notice.mjs`, runs at session start and, at most once a day per repo, says when the repo's Bindwright files are older than the plugin (pointing at `/bindwright:update`) or a newer plugin is out. It reads the released version from `VERSION` on `main` at most once a day with a two-second timeout, caches what it found in `~/.claude/bindwright/notice.json`, and says nothing offline, when nothing is behind, on any error, or on a machine without Node.

- **`/bindwright:update`** (#418). A new plugin skill brings a set-up repo up to today's templates without losing its own edits. The engine (`engine/update.js` and its Python twin, run as `cli.js --update` or `bind.py --update`) rebinds the answers saved in `.bindwright/project.json` and merges each file three ways with `git merge-file`, against the render saved in `.bindwright/pristine.json`. Files the repo never touched take the new text, edits on other lines merge in, and a clash on the same lines, or one that would change a `bindwright:keep` section, leaves the repo's file alone and stages the merge with all three versions marked for the user to settle. Owned files are skipped, new template files are written or staged, and files the templates dropped are offered for deletion one by one. Nothing is committed.

- **Code-size check with a ratchet** (#417). A new engine switch, `codeSizeCheck` (off by default), ships `.github/scripts/size_check.py` and a `Size check` workflow. The script reads its limits from the project's `code-size.md`, so the rule stays the one place they live, and measures file length, line length, and each function's length, complexity and parameters (through lizard, pinned in the workflow). Breaches the repo had at setup go in `.github/size-check/baseline.txt` and may only shrink; any new hard breach fails the PR, and accepted ones go in `exceptions.txt` with a reason. Without lizard the check fails rather than skipping rows silently. Setup writes the first baseline.

- **Hand-offs in the tracker** (#417, step 1 of `docs/v2/HANDOFF.md`). A new engine choice, `tracker`, replaces the `context_refresh_files` switch. With `github`, the default, the work state lives in GitHub issues: each issue's `### Current state` is the hand-off, project health goes in project status updates posted only when the state really changes, and a new rule, `.claude/rules/tracker.md`, holds both plus the `gh` commands for reading and writing them, with or without a Projects board. `/session-start` reads the open items and the newest status update instead of the hand-off file and `ROADMAP.md`; `/session-close` rewrites the issues it worked on after the PR step, so no hand-off PR or CI run is needed. `trackerProject` names the board (`"<owner>/<number>"`, held to GitHub's name rule since it lands in command lines). `file` keeps the old hand-off file and `ROADMAP.md`. Every bind also writes `.bindwright/session-steps.md`, where a project lists its own extra start and close steps; the engine leaves it out of the pristine render, since it is the project's from the start. The older page and `SETUP.md` do not read the new choice, as with `merge_style`.

- **Plugin skeleton and `/bindwright:setup`** (#330). `plugin/` holds the plugin's manifest and its setup skill; `tools/pack_plugin.py` assembles the installable plugin in `dist/bindwright/` from it, the engine's runtime files and the templates the engine reads, about 470 KB. The skill takes a setup code (`bw1-` plus the answers in base64url, made by the page), writes the files with whichever engine the machine has (`engine/cli.js` for Node, `bind.py --code ... --write ...` for Python), merges the files the repo already had, fills the placeholders only the repo can answer (description, stack, lint, type-check and test commands, languages, owners), and trims the code-size table to the repo's languages. It never overwrites a file without a yes and commits nothing. Tests check that both decoders read every code alike and refuse bad ones with the same message, that both writers and both commands write the same bytes, and that a fresh pack binds what the repo's engine binds. The engine now checks the answers' shape first, since a setup code can carry anything. Every bind also renders the files offered for the user's own `~/.claude` into `.bindwright/global/` (the global `CLAUDE.md` additions, the memory index, the push guard, the attribution guard when the guards live in `~/.claude`, and the research hook for CodeGraph or a custom tool), so the page, the zip and setup share the same bytes. Setup offers each one separately, plus the chosen research tool's install commands and the mods, and installs only what the user agrees to through `engine/home.py`, which backs up `~/.claude/settings.json` before every change, registers hooks in the launcher form that a missing file cannot turn into a block on every command, and keeps an installed mod's own edits. The pack grows to about 1.3 MB with the mods, without their tests.

- **Python twin of the bind engine.** `engine/model.py`, `render.py` and `bind.py` (standard library only, Python 3.8+) produce the same files as the JS engine, byte for byte, so setup can run wherever Node or Python exists. `python engine/bind.py < answers.json` prints the file set as JSON. A golden test binds about 200 answer sets with both engines and fails on any difference in files or in error messages. To make the two match, the JS engine now sorts files in plain character order instead of the browser's locale order, and checks the type of every answer (a project name given as a number, or a tool named `toString`, used to slip through).

- **Code-research tool profiles as data, and a custom tool** (#329). `_core/global-template/hooks/code-research-profiles.json` moves to schema 2: one profile per engine tool (tokensave, none, custom) with install commands per OS, the step that wires the tool into the agent, per-project indexing, the MCP entry for manual setup, and who provides the search-redirect hook. Every command was checked against the tool's README; setup is to show each one and run it only with consent. The ast-grep, Sourcegraph, ctags and Semgrep profiles, and their blocks in the global `CLAUDE.md.additions`, are gone; that file keeps blocks only for the tools setup offers. A new engine value, `codeResearch: "custom"`, takes a name and an https URL from a new `codeResearchCustom` answer and derives the kebab name, bypass marker and adherence pattern, which counts only MCP tool calls so a name like "Grep" cannot count the built-in tools; `/find` gets a sequence for it. An engine test keeps the profile keys and the global blocks equal to the engine's tool list.

- **Project file list for the writing rule.** A new engine switch, `shippedTextPaths`, sets which files the writing rule (`shipped-text.md`) applies to, as a list of globs. It replaces the rule's default list (README, changelog, `docs/`, translation files), which suits projects that ship text in other file types or keep `docs/` internal. Left unset, the rule keeps its default list. Globs with quotes, backslashes, line breaks or outer spaces are refused.

- **Guard hooks ship inside the project.** A bind now writes `.claude/hooks/run-hook.sh`, `push-guard.py` and `no-ai-attribution.py`, registered in a committed `.claude/settings.json`, so teammates and cloud sessions run the guards too. The launcher finds Python 3.8+ outside any virtual environment, fails open when a file is missing, and steps aside for a guard already registered in `~/.claude/settings.json`, so a guard never runs twice. A `.gitattributes` keeps `*.sh` on LF line endings. Two new engine switches: `hookLocation` (`repo`, the default, or `home`, which ships no project hooks and leaves SETUP.md Phase 7c and the new 7d to install them in `~/.claude`) and `attributionGuard` (on by default). The attribution guard denies AI attribution (an AI co-author trailer, a "generated with" line, session links, the robot emoji) in git and gh writes and the message files they name, while plain mentions of a tool pass. Turning it off also drops the `attribution` settings, the git rule's no-attribution line and the review workflow's attribution scan. `.gitattributes` and `.claude/settings.json` land in `.bindwright/incoming/` for merging, and the hooks are copied byte for byte. The shipped hooks are the files this repo runs; an engine test fails when the copies drift.

- **Global push guard** (PR #158). `_core/global-template/hooks/push-guard.py` is a `PreToolUse` hook for Bash and PowerShell that SETUP.md Phase 7c installs in `~/.claude` on every bind (with the Python interpreter it finds, in exec form). It reads the command's text with quoting removed and blocks force pushes that text rules cannot see (`-f` inside a short-flag bundle such as `-qf`, `--mirror`, `+` refspecs, forcing `-c` settings and one-off aliases, anywhere in the command, including inside `$(...)`, `sh -c`, `eval` or a heredoc), and keeps `--force-with-lease` allowed. It never asks. Text that only mentions a force push is blocked too, as, rarely, is a plain push chained after a quoted string that spans lines or in a Bash command with a `\` ending a line when a force word follows it anywhere; the message says to pass such text in a file, or to put such a command on one line or run the push as its own command. It is a safety net for force pushes written the ordinary way, not a sandbox; its docstring and the setup question list what stays out of reach. Its reading is linear in the command's length, so it answers well inside the hook timeout. Setup lists the guard in the plan it shows before applying, and asks `[y/N]` before adding a global `Bash(git push:*)` allow that lets pushes skip the prompt in every project.

- **Pre-commit tool slot promoted to profile-driven config generation**, following the `code_research` precedent (project-local rather than global). Adds `_core/project-template/precommit/precommit-profiles.json` (a lean per-manager profile: `config_filename`, `template_ref`, `activation_command`, `runtime_note`, `url`) plus config templates for **husky** (`.husky/pre-commit`), **pre-commit** (`.pre-commit-config.yaml`), and **simple-git-hooks** (`.simple-git-hooks.json`); the existing `lefthook.yml.template` moves into the same directory. All four carry the shared `{{LINT_COMMAND}}` / `{{TYPECHECK_COMMAND}}` / `{{TEST_COMMAND}}` placeholders. Adds the `precommit_hooks_scaffold` boolean to the four `bundles/*/bundle.toggles.md` (OFF/ON/OFF/ON) + the `TOGGLES.md` master catalog, a `key` field per precommit option in the two primary configurator mirrors (`redesign/data.jsx` + `index.html`; the `index.legacy.html` fallback keeps its keyless `<select>` schema), and a per-manager `<!-- TOGGLE:precommit:<value> -->` section in `git.md` nested under the scaffold gate. The bind **writes config + emits the activation command as an instruction — it never runs installs** (the install-hint surfaces the manager's runtime note + URL). Five placeholders (`TOOLS_PRECOMMIT_NAME`, `TOOLS_PRECOMMIT_URL`, `LINT_COMMAND`, `TYPECHECK_COMMAND`, `TEST_COMMAND`) were registered in the `claude-code-review.yml` canonical scan first (#141). (Originally a v1.3.0 "Known follow-up" labeled for v1.4.0; v1.4.0 shipped past it, so it lands here for the next cut.)

- **Mods for `~/.claude`** (Claude Code 2.1.287+). `_core/global-template/mods/` ships ten function-hook plugins, each with its manifest, hooks module and tests: `session-facts` (local time, context fill against the compaction window and plan usage on every prompt, plus a budgets row above the prompt), `session-info` (model, effort, project and git branch in a band row), `compact-handoff` (compaction as a budgeted hand-off that keeps the person's messages word for word, plus a transcript `recall` tool), `ci-watch` (watches a pushed PR's checks locally, shows each PR's progress in a band row and wakes the session once), `shared-pc` (one session at a time runs heavy work on a shared machine), `skill-check` (one follow-up turn when a skill's run skips a required step, with example contracts for `/session-start` and `/session-close`), `tasks` (keeps the task list current and visible), `usage-guard` (saves work and pauses sessions near a plan limit, then resumes after the reset), `runners` (local CI runners in a band row, with Start and Stop) and `mods` (`/mods` opens a pane listing the loaded mods and the slash commands they add). All but `runners` and `shared-pc` are recommended on; those two are opt-in. They install through `CLAUDE_CODE_PLUGIN_DIRS` and keep their data under `~/.claude/mods-data/<mod>/`, and run in both the terminal and the Desktop app's Code tab; the tests draw each band and pane on both surfaces. `mods/README.md` covers install, options, tests and notes for writing a mod.

### Changed

- **The project is Bindwright** (#342). The repo moves to `starfoxcom/bindwright` and the site to `starfoxcom.github.io/bindwright`; every link, the plugin's homepage and update check, the bug-report link and this repo's own saved answers follow. GitHub forwards the old repo address; the old site address does not.

- **Code-search choices cut to tokensave, none and custom** (#564). A head-to-head test ran tokensave, CodeGraph, Serena, codebase-memory-mcp, the LSP plugins and no tool on the same 40 questions and 6 multi-step tasks across two repos. Every setup answered correctly, plain search included; the tools differed only in speed and cost, and none beat tokensave on either, so setup, the profiles, the global `CLAUDE.md.additions`, the `/find` skill and the settings page offer only tokensave (recommended), none and custom.
- **Every extra starts on.** The deeper review for risky changes, the visual-steps rule, the plain-writing rule and the code size check are now on by default for every setup, solo projects included. Each one can still be turned off.

- **Setup codes refuse anything the page does not offer.** A code with a key the engine does not know, at any level, is refused, and so is one that carries `repoUrl`, `licenseHolder`, `codeResearchCustom` or `shippedTextPaths`, which the page never sets, so a tampered code cannot put text into the files the assistant reads. Saved answer files are unaffected. The page shows its setup command only when the code passes the same checks.
- **Error messages quote bad values safely.** When a setup code or saved answer file holds a value the engine refuses, the message quotes at most 40 characters of it and escapes quotes, line breaks and other control characters, so a tampered value cannot add lines to the message the assistant reads.
- **A third setup answer: is the project private?** The second question becomes "Mine" or "Someone else's" (open source, a client, or a team the person joined), and every project is asked whether it is private. For your own project it picks the default license: Proprietary when private, MIT when public. For someone else's project it turns on the `confidentiality` rule and `audit_trail_commits` when private and leaves them off when public. Answers saved before this question read `private` as equal to `client`, so they bind as before.
- **Someone else's project no longer gets a `LICENSE`**, since the owner's license stands. On `/bindwright:update`, an untouched `LICENSE` from an earlier client setup is offered for deletion and the person decides; an edited one stays.
- **Setup codes carry only the non-default answers.** A `bw1-` code holds `team`, `client` and `private` plus any value that differs from their defaults, and decoding rebuilds the rest, so the page's setup command stays short. Older full-length codes still decode, and `encodeSetupCode(answers, { full: true })` still writes them.
- **Review findings block only when the PR causes them.** `review-tiers.md` gains "What a finding blocks on": a finding blocks when it is a regression from the base branch or breaks what the PR says it does; a gap the base branch or the comparable community tool already shares becomes a follow-up issue instead. The bar goes into every reviewer prompt from the first round, each finding is sorted against it before any fix, fixes stay minimal with no new features (the other copies of a mistake being fixed are still fixed in the same commit), and every sixth red round in a row brings a look at how others solved the problem and a simpler design.
- **ci-watch asks for a step back instead of refusing pushes.** The fix-round limit no longer refuses a push after six red rounds in a row. Every sixth red round (6, 12, 18, ...) the failure wake asks the session to research how others solve the problem, pick the simplest design that removes the whole class of findings, tell the user, and keep going. `/ci-watch rounds` shows the count and when the next step back is due. The user-only reset, the guard on the count's file and the push reader that only the refusal used are gone.
- **Agent calls follow the session's model** (#331). `token-efficiency.md` gains an "Agent calls" section: `Workflow` and agent calls leave `model` and `effort` out, so they run on the model and effort the person picked for the session instead of overriding it.
- **Long sessions keep working through a compaction.** `token-efficiency.md` § Long sessions no longer sends a session to the close ritual as its context fills: an approaching auto-compaction is no reason to stop, and `/session-close` runs when the maintainer asks or every task is done. Without a compaction hand-off, the task list is kept current instead. The `session-close` skill's description says the same.
- **Review workflow templates carry an effort and a backup reviewer.** Both tiers default to Fable 5.1 at low effort and fall back once to Opus 5.5 at high: the routine tier when its main attempt returned no review the gate can read, the deep tier at once on a spent usage allowance and otherwise after one same-model retry that also left no verdict. Four new bind placeholders (`REVIEW_DEEP_EFFORT`, `REVIEW_ROUTINE_EFFORT`, `REVIEW_BACKUP_MODEL`, `REVIEW_BACKUP_EFFORT`) join the two model ones, the action pin moves to v1.0.213, the backup runs on a job-private newer CLI, reviewers may read git history and cannot start helper agents, and each gate names the attempt that wrote the verdict. The page and docs describe the tiers without naming a model.
- **Merge commits are the default merge style.** The engine's `mergeStyle` now defaults to `merge`, so a bind's `git.md` merges every PR with `gh pr merge <pr> --merge --delete-branch` and each branch stays visible in the history graph. `squash` and `rebase` remain the other options. This repo's own rules (`CLAUDE.md`, `git.md`, `token-efficiency.md`, `collaboration.md`) switch to merge commits too.
- **The deny list moves to the committed settings, in two profiles.** `.claude/settings.json` now carries `permissions.deny`, so teammates and cloud sessions get it; `settings.local.json` keeps only the allow list. A new engine switch, `denyProfile`, picks the list. `standard` (the default) keeps the force-push, `--mirror`, `--upload-pack` and `gh repo sync --force` rules (`--force-with-lease` stays allowed) and adds direct pushes to the main and development branches (by name, `HEAD:` refspec, `refs/heads/` or deletion), interactive rebase and `gh pr merge --admin`. `strict` adds `git reset --hard`, `git clean -f` in its common spellings, deleting the main or development branch locally, `gh repo delete` and `gh api` DELETE calls. `git reset --hard`, `git clean -f` and `git branch -D main`/`develop` were in the old default list and now come only with `strict`; `git branch -D master` is gone, since the main branch is `{{MAIN_BRANCH}}`.
- **Workflow-only PRs from the maintainer's own sessions merge on two local reviews.** `review-tiers.md` no longer makes the maintainer read every PR that changes `.github/workflows/`, and `token-efficiency.md` and the review-workflow template's header comment point to it. No AI reviews such a PR in CI. When every commit in it was written in the maintainer's own sessions, two fresh subagents (not forks of the authoring session, each given only the diff and its prompt) review the exact head commit that will merge: one on the review steps and verdict rule of the routine-review prompt taken from the base branch's copy of the workflow, never the PR's own, running the pre-screen checks itself, and one as a whole-diff deep review. Neither posts to the PR; each returns its verdict to the author. Once both give 🟢, a PR comment records the head SHA and both verdicts, and the PR merges only while that SHA is still its head; any new commit re-runs both. Anything else, including a maintainer-opened PR that carries someone else's commits, still merges only after the maintainer has read its whole diff.
- **Project push rules narrowed** (PR #158). The project allow list keeps only a bare `Bash(git push)`, so pushes with arguments prompt unless the global guard's auto-approve is on. The deny list now covers `--force` and `-f` in every argument position, `-uf` bundles, `+` refspecs, `--mirror`, `git fetch`/`git pull --upload-pack`, `git remote --mirror` and `gh repo sync --force`. The `git push` stack-command chip is removed, and setup (canonical and the page's fallback copy) never renders a `git push` or bare `git` stack command as an allow rule.
- **`tokensave_entry_point` toggle renamed to `code_research_first`** with backward-compat alias resolution (shape pre-committed in SETUP.md Phase 1 step 4; mirrors the `developer_branch`/`default_branch` precedent). `code_research_first` is now the canonical toggle name across the catalog (`TOGGLES.md`), the four `bundles/*/bundle.toggles.md` default sets, the configurator (`index.html` + `redesign/data.jsx` + `redesign/bind.jsx` + `index.legacy.html` — toggle id, state keys, bind file-map, and the inlined SETUP stub), the canonical block-strip markers (`_core/project-template/CLAUDE.md`, `.claude/skills/find/SKILL.md` incl. its `:off` variant, `.claude/skills/session-close/SKILL.md`), `_core/global-template/README.md`, and SETUP.md's resolution + detection steps. The legacy `tokensave_entry_point` name is retained as a deprecated alias — manifests bound before the rename keep working (SETUP.md Phase 1 accepts it and warns; the inlined stub's cross-check tolerates it too). Alias removal stays slated for v2.0.0. No behavioral change to bind output beyond the emitted toggle key. (Originally tracked as a v1.3.1 follow-up; v1.4.0 shipped past that label, so it lands here for the next release cut.)
- **SETUP.md step 8e generalized** from a hardcoded `lefthook.yml` copy into a `tools.precommit` profile lookup (copy the profile's `template_ref` → `config_filename`, substitute the lint/typecheck/test commands, emit the profile's `activation_command`; `none`/`custom` short-circuit). Phase 1.5 Discovery now infers both `tools.precommit` and `precommit_hooks_scaffold` from config-file presence, and the `precommit_hooks_scaffold` gate label is de-lefthook-ified across all three configurator mirrors.

### Removed

- **The v1 page** (#491). The site's root now redirects to the v2 page in `page/`. Gone: the v1 configurator (`index.html`'s React build, `index.legacy.html` and its `redesign/` source), the review check that kept the JSX and the HTML in step, and the engine tests that read the v1 page's chips and setup copy. Deep review now fires on `_core/` and `engine/`, which renders every bind.

- **The v1 setup docs and bundles** (#572). `SETUP.md`, `TOGGLES.md`, `COMPARISON.md` and the four `bundles/` are gone: `/bindwright:setup` asks the questions and the engine renders the files. The shipped templates that pointed at `SETUP.md` (the code-research hook, the global README, the architecture and pre-commit notes) now point at the plugin, the README describes the plugin install, and the gate always reviews `plugin/`.

- **Status lines.** `_core/global-template/statusline.js`, `statusline.config.example.json` and `statusline-command.sh.template` are gone, with SETUP.md step 7b that installed the bash one. The Desktop app does not draw a command status line, so the mods draw the same facts as rows above the prompt instead, in the terminal and in Desktop alike: `session-info` (the session), `ci-watch` (CI), `runners` and `session-facts` (budgets). `session-facts` no longer writes a per-session file for the status line. On an existing install, remove the `statusLine` block from `~/.claude/settings.json` and delete `~/.claude/mods-data/statusline/` and `~/.claude/mods-data/session-facts/`.

- **Session-start model + effort recommendation, context budget audit, and session-close outcome log** (PR #134). Removed the model/effort-selection apparatus added in v1.4.0 from the session-lifecycle skills, reverting `session-start` and `session-close` to their pre-feature structure. Gone: the context budget audit, the capability-tier ladder (Deep / Standard / Frugal), the session-archetype→tier matrix, the pinned-incumbent resolution sub-step + pins table, the `## Recommended setup for this session` emit block, and the `## Session model setup` outcome log + promotion-check nudge. Touches both the canonical templates (`_core/project-template/.claude/skills/session-{start,close}/SKILL.md`, `_core/project-template/CLAUDE.md` SESSION START) and their live `.claude/` mirrors, and drops a now-stale `SETUP.md` cross-reference to the removed discipline. **Rationale:** pinning the ritual to a specific model is a liability when model availability can change without notice, and in practice the recommendation added per-session context cost without changing day-to-day behavior. The CI PR-review model surface (`{{REVIEW_DEEP_MODEL}}` / `{{REVIEW_ROUTINE_MODEL}}`) is a separate concern and stays. No bind-UI/toggle change — the feature was always-on prose, never gated by a toggle. (This supersedes the in-cycle Deep-pin promotion recorded on PR #133, which never shipped in a release.)

### Fixed

- **The size check measures TypeScript functions right.** lizard loses its place after an object type inside a generic (`Promise<{ name: string }>`) and folds the functions after it into one, so a short function could fail the check. The check now reads each top-level statement of a `.ts` or `.tsx` file on its own, so a misread stays inside that statement.
- **Review jobs run the newest CLI release, with the stable release as the backup** (#436, #437, #439, #440, #442, #443, #445, #446, #448, #449, #450, #452, #453, #457). Each review workflow template reads the newest release when the job runs, from the channel the official installer reads, installs that exact version once and logs it. The credits run and the action's main attempts run that copy, where one job used to run up to three hand-pinned versions (the credits run's pin, the action's bundled CLI and an older backup pin). When the main review returns no review the gate can read, the backup model runs on the stable channel's release instead, so a newest release that installs but breaks at run time no longer fails every attempt; when the stable install fails, the backup reuses the newest copy. When the newest lookup or install fails, the action falls back to the CLI it bundles and the credits run is skipped. Routine review attempts post nothing: each returns its review and any deep-review request as structured output, a check runs the gate's own reader on the exact body to be posted, and one workflow step posts it as the review bot, with retries that never post twice. So an attempt that crashes, hangs or would post late cannot leave a second verdict, and only a review the gate can read counts; anything else hands over to the next attempt. When a deep review is owed, that step applies the label and posts the request (the reviewer's own, or the fixed brief). Deep review attempts are counted the same way, by the verdict the gate reads rather than how they exited, so one that exits cleanly without a verdict hands over to the retry and then the fallback; one that posted stops all later attempts. The error and summary lines name the CLI version each attempt ran, and an install that leaves no working binary says so. Every review attempt, install and download has a time limit, so a release that hangs or a stalled host fails into the same fallbacks instead of holding the job for six hours. The weekly pin check now covers only the action's commit and a test workflow's `PINNED_VERSION`.
- **Reviewers no longer inherit the maintainer's local allow list.** The review action loads every settings file by default, including `.claude/settings.local.json`, whose allow list lets a session commit, push and merge. Every review step in both workflow templates now passes `--setting-sources user,project`, so reviewers keep the project's rules, hooks and deny list and run only the tools their `--allowedTools` names.
- **Reviewers can only read the PR and comment on it.** The reviewer's bot token can write repo contents, and `Bash(gh *)` plus `Bash(git diff*)` let a reviewer steered by PR text merge other PRs, move tags, push, edit other PRs, remove the deep-review label, or write files through `git difftool` and `--output`. Every review step in both workflow templates now allows only `gh pr view/diff/checks`, `gh issue view`, `gh run view/list` and `Read`, plus, in the deep tier, comments on the reviewed PR (routine reviewers have no comment or label tool at all: the workflow posts their review); leaves git reads to the CLI's built-in read-only check; denies file edits, git writes and programs run by absolute path; and passes `--permission-mode default`, which overrides the `acceptEdits` mode the action sets for the deep tier. The routine job's Resolve step now applies a missed `needs-deep-review` label when the reviewer posted the trigger, so a refused label command cannot mark the deep check skipped.
- **Review workflow template no longer passes large PRs unreviewed.** `gh pr diff` fails with HTTP 406 past 300 changed files, so triage died and the gate read its empty output as a docs-only PR and passed it. Triage now lists files through the paginated files API (renamed files' old paths included) and reviews any PR whose listing fails or reaches the API's 3,000-file cap; `Evaluate review outcome` fails closed when triage does not succeed; the pre-screen and the reviewer read the diff with `git diff origin/<base>...HEAD`.
- **Canonical Step 4 trigger-comment guidance — backtick-skip clarifier** (PR #128). The canonical `_core/project-template/.github/workflows/claude-code-review.yml.template` Step 4 "CRITICAL — do not skip step B" paragraph was missing the live workflow's trailing sentence noting that an `@claude` token appearing only inside backticks or a code block causes the deep tier to silently skip. Completes the live↔canonical lockstep on that paragraph (the rest of the Step 4 block was reconciled in v1.4.0, #122).
- **Live review-workflow comments — stale lifecycle + bypass scope** (PR #129). Corrected stale `conclusion=neutral` lifecycle comments in `.github/workflows/claude-code-review.yml` + `claude.yml` (the `init-deep-check` job creates the `Claude On-Demand` check at `status=in_progress`; "neutral" appeared in no code path), and narrowed the admin-bypass-scope comment from `claude*.yml` to `claude-code-review.yml` (the glob wrongly implied `claude.yml` edits trip OIDC, contradicting `review-tiers.md`). Comment-only; the canonical templates already carried the accurate wording.
- **Canonical review prompt — full BINARY VERDICT RULE prose** (PR #131). The canonical `claude-code-review.yml.template` review prompt was an abbreviated version of the live one — missing the 🔴 "minor nit → 🔴 / all-clear-with-caveats = contradiction" clauses, the "'All clear on X' is allowed as a section heading, never as the verdict line" bullet, and the Step 2.5 "verdict stays binary regardless" clarifier — all of which the canonical's own `review-tiers.md` states in full. Mirrored so downstream binds inherit the complete contract. (The 🟡 block's auto-fire-specific "depth-pass follows" line was intentionally left out — the canonical 🟡 block is toggle-agnostic and must read correctly with auto-fire OFF too.)

These two + the #128 backtick-skip fix close out a full live↔canonical reconciliation audit of the review workflows that found **no behavioral drift** — only documentation/prose gaps.

## [v1.4.0] — 2026-06-15 — canonical-template parity + session-lifecycle tuning

v1.4.0 completes the **canonical-template + bind counterparts** of the live-workflow work that shipped in v1.3.0 (see [v1.3.0] § "Also shipped — CI review-gate hardening") — the two-tier review gate's Checks-API architecture, the routine reviewer prompt, the deep-review model, and the workflow-template tokenization now all live in `_core/` so downstream binds inherit them. It also adds **session-lifecycle intelligence**: a context budget audit and model/effort tier ladder at session-start, time-of-day awareness via an optional injection hook, and a session-close outcome log. Minor bump — new features, no breaking change.

### Added

- **Time-injection hook docs + AI awareness** (PR #104). New `_core/global-template/hooks/time-injection.snippet.md` documents an optional `UserPromptSubmit` hook that injects `[time] YYYY-MM-DD HH:MM:SS <zone>` into every prompt. Parameter-free — the zone is resolved at call time via `Intl.DateTimeFormat().resolvedOptions().timeZone` (Node) or `datetime.now().astimezone().tzinfo` (Python fallback, OS-localized form). `_core/global-template/README.md` § 4 documents installation; `_core/global-template/CLAUDE.md.additions` § "Time-of-day awareness" tells models to attend to the injected lines and trust them over terminal `date` re-derivations. Lifts GameProject's local fix into canonical so every downstream bind picks up the same time-of-day-awareness discipline without per-project bind substitution.
- **Routine reviewer prompt — FAIL-CLOSED enforcement, canonical template** (PR #106). The canonical `_core/project-template/.github/workflows/claude-code-review.yml.template` gained the three Step-3 additions the live workflow shipped in v1.3.0 (#105): a FAIL-CLOSED warning stating the parser is strict (`grep -E "🔴|🟢" | tail -n 1`) and bare `LGTM` is a missing verdict; a WRONG-formats list (bare `LGTM`, wrong emoji like ✅, missing `— must fix` suffix, caveats variants, trailing prose); a pre-post self-check. Keeps the canonical mirror in lockstep so downstream binds inherit the same strict verdict-emoji enforcement.
- **Session-start context budget audit** (PR #103). Canonical `_core/project-template/.claude/skills/session-start/SKILL.md` gained a "Context budget audit" step that inventories the eager-load corpus (`.claude/rules/*.md`, `MEMORY.md`, project + global `CLAUDE.md`, the session handoff, auto-loaded skills) and applies a free-context budget-adjustment table (≥75% → use the model matrix as-is; 60–75% → flag the tight buffer; 45–60% → escalate to the Deep tier's 1M-context variant; <45% → stop and trim eager-loads or switch to 1M context before starting). The step runs before the model + effort recommendation (renumbered to follow it); `_core/project-template/CLAUDE.md` SESSION START gained the matching step. Folds session *budget* (window pressure) into the model-selection ritual so every downstream bind measures eager-load cost before locking model + effort.

### Changed

- **OS-clock-first session-close** (PR #104). Canonical `_core/project-template/.claude/skills/session-close/SKILL.md` § "Update context" now checks the time-injection hook output as step 1 (authoritative when present); step 2 falls back to OS-clock-only terminal commands with NO hardcoded IANA strings (`'America/Mazatlan'` etc.). Hardcoded zones inherit US-DST assumptions that are wrong for non-US-DST locales — OS clock is always the right source. Live mirror `.claude/skills/session-close/SKILL.md` re-resolved against the new canonical.
- **Session-start model + effort analyzer** in `_core/project-template/.claude/skills/session-start/SKILL.md` and `.claude/skills/session-start/SKILL.md`. New step emits a `## Recommended setup for this session` block before the approval gate. The matrix is keyed to **capability tiers** (Deep / Standard / Frugal), not model versions — archetype → tier / effort — and a resolution sub-step turns the tier into a concrete `/model <id>` via a **pinned-incumbent rule** (the model the project's outcome log has *proven* — never newest-by-default) with a visible `<unverified — confirm via /model>` fallback that halts at the approval gate. Because the tier ladder names no model version, the **canonical carries zero model IDs and needs no per-release edit**; it stays generic + evidence-neutral and marked "starting point, not permanent answer". The project-local file maps this repo's archetypes (workflow YAML state-machine surgery / lockstep canonical+live edits / bind resolution / multi-PR cascade) to tiers and carries the single project-private pin block (`Deep → claude-opus-4-6[1m]`, `Standard → claude-opus-4-6`, `Frugal → claude-sonnet-4-6`) alongside the version-specific 4.6-vs-4.7 evidence.
- **Session-close outcome log** in `_core/project-template/.claude/skills/session-close/SKILL.md` and `.claude/skills/session-close/SKILL.md`. Appends a `## Session model setup` block (`Recommended at start / Used / Outcome`, each recording **both tier and resolved id** so the log stays comparable as concrete IDs drift) to the regenerated context file, plus a **promotion-check nudge** that flags when a newer top-tier model has been available for several sessions without the pin being re-evaluated. Empirical feedback loop for tuning the tier-resolution pins. **Lives inside the `context_refresh_files` toggle block** so disabling that toggle strips both file-generation and outcome-log coherently.
- **Canonical SESSION START prose updated** in `_core/project-template/CLAUDE.md` — the `Recommended model + effort` step now describes picking a capability tier and resolving it to a concrete `/model <id>` via the skill's pinned-incumbent rule (not newest-by-default), keeping step ordering aligned with the SKILL (the archetype match needs the planned step list as input).
- **Plan-tier tuning guidance** in canonical session-start SKILL.md — documents how Pro / Max / Team / Enterprise / API cost and 1M-context availability vary by tier (map Deep → Standard / Frugal on cost-sensitive plans); cites the [official Claude Code model config docs](https://code.claude.com/docs/en/model-config#extended-context). The canonical refers to the 1M-context variant as a capability ("your plan's 1M-context suffix"), not a literal id, so it stays version-free.
- **Memory entry: `feedback_model_default_opus_4_6`** — captures why this repo pins the Deep tier to Opus 4.6 rather than the newer 4.7 on high-judgment / long-context / multi-step-discipline sessions, sourced from [anthropics/claude-code#58369](https://github.com/anthropics/claude-code/issues/58369) evidence (project-private memory, not shipped); the rationale behind the mirror's pinned-incumbent block.
- **Deep-review CI model 4.7 → 4.8, canonical template** (PR #112). The canonical `claude.yml.template` matched the live `.github/workflows/claude.yml` deep-review `--model` bump to `claude-opus-4-8` (the live half shipped in v1.3.0, #111). Adopted as a **watched trial** per the repo's pinned-incumbent discipline — 4.8 remediates 4.7's long-context-retrieval + multi-step-instruction-following regressions at the same price. Routine review stays `claude-sonnet-4-6` (no Sonnet 4.8). Monitor the next several deep-review verdicts; revert (one-line) if it degrades.
- **Canonical review-workflow templates tokenized** (PR #116). The deep/routine `--model` in `_core/project-template/.github/workflows/claude.yml.template` and `claude-code-review.yml.template` is now a `{{REVIEW_DEEP_MODEL}}` / `{{REVIEW_ROUTINE_MODEL}}` placeholder (default-only, no bind-UI field), and the model version is dropped from each template's header comment + job display name — so a future model release edits **zero** files under `_core/project-template/`. Same staleness fix the session-start skill got, applied to the workflow templates. (The live-label de-version, the canonical placeholder-allowlist registration of the two tokens, and SETUP.md Phase 3 resolution to deliberate stable defaults — `claude-opus-4-8` deep / `claude-sonnet-4-6` routine — shipped in v1.3.0, #113/#115. Live workflows keep concrete `--model` literals.)

### Removed

- **`{{TIMEZONE}}` placeholder, canonical + bind** (PR #104). The placeholder existed solely to feed a `timeZone:` option to one hardcoded Node command in the canonical session-close skill — now obsoleted by the OS-clock-first principle. Removed from canonical `_core/project-template/.claude/skills/session-close/SKILL.md`, `SETUP.md` (placeholder mapping + JSON example + Discovery question step), `redesign/bind.jsx` ↔ `index.html` (state init, audit packet, both Field UIs, `advancedFilledCount`, discovery-copy line; Discovery preferences annotation `2 THINGS` → `1 THING`), and `.claude/BIND.md` placeholder table. (The workflow's CANONICAL-allowlist entry drop shipped in v1.3.0, #107.)

### Fixed

- **Canonical-template + rule mirrors of the v1.3.0 CI review-gate hardening** (PRs #79, #85, #92). v1.4.0 is the first tag to ship the `_core/` canonical counterparts of the two-tier review gate whose live-workflow halves shipped in v1.3.0 (detailed in [v1.3.0] § "Also shipped — CI review-gate hardening"). The mirrored items: the **two independent required status checks** (`Evaluate review outcome` + `Claude On-Demand`) and the deep-tier merge-gate fold (#83/#87 live → #85/#92 canonical); the **`Claude On-Demand` lifecycle** + fail-closed-on-Opus-error (#89/#90 live → #92 canonical); the **hardening invariants** — stale-verdict/stale-comment floors, Resolve-step terminal-state guard, `init-deep-check` self-heal POST, narrowed OIDC scope, corrected fast-path rollup expectations (#97 live → #92 canonical); and the **`🟡 Uncertainty surfaced` escalation-verdict requirement** + cascade-after-main-merge discipline + branch-verification rule (#78 live → #79 canonical). Brings the canonical `_core/project-template/.github/workflows/*.template` + `.claude/rules` into lockstep with this repo's live workflows so downstream binds inherit the full gate architecture, not just its live half. (The #99 non-reviewable terminal-state guard and #105 verdict-emoji enforcement canonical mirrors are the separate entries below / in Added, #122 / #106.)
- **Deep-trigger verdict enforcement — FAIL-CLOSED + WRONG-formats + self-check** (PR #120 live, PR #122 canonical). The routine reviewer's Step 4 trigger comment — the text the Opus deep reviewer reads as its verdict-format spec — carried only the binary rule + output spec. The routine Step 3 prompt gained the full FAIL-CLOSED enforcement warning + WRONG-formats list + pre-post self-check in v1.3.0 (#105 live / #106 canonical), but the deep-trigger comment never did. Both tiers' verdicts are parsed by the identical `grep -E "🔴|🟢" | tail -n 1` contract (routine: `Evaluate review outcome`; deep: `claude.yml`'s `Evaluate deep-tier verdict`), so the deep tier now gets the same anti-degradation guard. `claude.yml` passes no system prompt — this trigger comment is where the deep reviewer's verdict-format guidance lives, so the strengthening lands in `claude-code-review.yml`(`.template`), not `claude.yml`(`.template`). Live `.github/workflows/claude-code-review.yml` (#120, hotfix → `main`, admin-bypass on the App OIDC byte-identity trip) + canonical `_core/project-template/.github/workflows/claude-code-review.yml.template` (#122) in lockstep.
- **Canonical non-reviewable PATCH path — terminal-state guard** (PR #122). The canonical `claude-code-review.yml.template`'s `evaluate-review-outcome` non-reviewable branch PATCHed `Claude On-Demand` to `skipped` unconditionally. If a maintainer manually `@claude`-triggered a deep review on an otherwise non-reviewable PR and Opus set the check to a terminal `success`/`failure`, a routine re-run would clobber that authoritative verdict with `skipped`. Adds the same `EXISTING_STATUS`/`EXISTING_CONCLUSION` terminal-state guard the live workflow already carries (shipped v1.3.0, #99) — the canonical template was the last place still missing it (the reviewable Resolve path already had it).
- **Evaluate routine-comment selector — title-tolerant** (PR #123 live, PR #122 canonical). `evaluate-review-outcome` selected the routine verdict comment via `contains("## Code Review — <project>")` — the literal H2-heading + em-dash title. When the routine reviewer deviated (observed `**Code Review - …**` and a heading-less `Code Review — …`), the strict match missed a genuine 🟢 LGTM and the gate fail-closed on otherwise-clean PRs. The title is only a *selector key*, not a load-bearing contract like the verdict emoji, so the selector now matches the stable `Code Review` phrase scoped to `claude[bot]`. Live `.github/workflows/claude-code-review.yml` uses a project-name-anchored regex (`test("Code Review[^a-zA-Z]+claude-code-templates")`); the canonical `claude-code-review.yml.template` deliberately uses a name-independent `contains("Code Review")` so a downstream project name with regex/substring-special characters can't silently break the gate. Live #123 (hotfix → `main`, admin-bypass on the OIDC byte-identity trip) + canonical #122. Same class as the v1.3.0 verdict-emoji enforcement (#105).

### Known follow-ups

- **Issue #95** — bind-time `plan_tier` selector for the session-start ladder. Now that the matrix is **tier-valued** (Deep / Standard / Frugal) rather than carrying concrete model IDs, the selector simplifies from "rewrite the model rows" to "annotate / filter by tier per the maintainer's plan" (e.g. collapse Deep → Standard on Pro). Scoped for v1.4 / v1.5. Touches `redesign/data.jsx` + bind logic + canonical `{{PLAN_TIER}}` placeholder + 4 bundle defaults + `BIND.md` schema. Until it lands, the canonical ships a `<MAINTAINER: …>` placeholder pin table in the resolution sub-step (filled in on first bind) plus the "Tuning for your plan tier" subsection as the manual bootstrap.

## [v1.3.0] — 2026-06-03 — code_research agnostification

The `tools.code_research` slot was promised in v1.0.0 (tokensave / ast-grep / Sourcegraph / ctags / Semgrep / none / other) but the canonical templates, the hook file, and the `/find` skill hardcoded `tokensave` references. Downstream users who picked a different code-research tool got templates that referenced tools their project didn't have. This release wires the slot through end to end **and establishes the per-value-marker + tool-profile-JSON pattern as the canonical mechanism for the other four tool slots** (`precommit` / `ci` / `ai_reviewer` / `issue_tracker`) that remain hardcoded or absent in templates today.

Scope intentionally exceeded Issue #10's letter — `/find` parametrisation pulled in `/architecture-graph`, `_core/project-template/.claude/rules/token-efficiency.md`, `_core/project-template/.claude/skills/session-close/SKILL.md`'s adherence-metric section, and `_core/global-template/CLAUDE.md.additions`'s no-Explore-agents rule, because hardcoded tokensave references in any of those would have re-exposed the same surface for the next person to hit.

### Added
- **Generic hook template + per-tool profile system.** `_core/global-template/hooks/code-research-first.py.template` is the new canonical hook. `_core/global-template/hooks/code-research-profiles.json` holds per-tool profile data (display name, bypass marker, detection mode + target, command sequence bullets) for tokensave / ast-grep / Sourcegraph / ctags / Semgrep / none / custom. The bind step picks the profile matching `tools.code_research`, substitutes its placeholders into the template, and writes the result to `~/.claude/hooks/<tool>-first.py` (e.g., `tokensave-first.py`, `ast-grep-first.py`).
- **Canonical SETUP.md shipped at bind time.** The configurator now fetches `SETUP.md` from the same-origin GitHub Pages deployment when assembling the zip. If fetch fails (file:// protocol, offline, CORS), it falls back to an inline stub that captures the v1.3 contract verbatim. Both paths produce a `SETUP.md` in the downloaded archive — downstream Claude sessions never read a stale stub.
- **Atomic write contract for `~/.claude/hooks/*.py` and `~/.claude/settings.json`.** SETUP.md § Phase 7a documents the `.tmp` + `fsync` + `os.replace` pattern; a crash mid-bind cannot corrupt the user's global hook config.
- **Profile schema validation step.** SETUP.md § Phase 7a validates the resolved profile against `code-research-profiles.json`'s inline `_schema` field (required-field presence, `detection_mode` enum, `bypass_marker` regex, `detection_target` path-traversal guard) before rendering. Malformed profiles abort with a clear error.
- **Per-value toggle marker syntax.** New marker shape `<!-- TOGGLE:<slot>:<value> START/END -->` for single-select tool slots (`code_research`, `precommit`, `ci`, `ai_reviewer`, `issue_tracker`). Symmetric with the existing boolean `:off` markers — same binder logic, parameterized by what to match against. Documented in TOGGLES.md § "Per-value markers for tool slots".
- **`{{TOOLS_<SLOT>_NAME}}`, `{{TOOLS_<SLOT>_URL}}`, `{{TOOLS_CODE_RESEARCH_BYPASS_MARKER}}` placeholders.** Substituted at bind time from the configurator's `tools.<slot>` selection + the hook profile JSON. Documented in SETUP.md § Phase 3 step 2.

### Changed
- **`/find` skill parametrised (closes issue #10).** Canonical `_core/project-template/.claude/skills/find/SKILL.md` now ships seven per-tool blocks (tokensave / ast-grep / Sourcegraph / ctags / Semgrep / none / custom); the bind step keeps only the block matching `tools.code_research`. Each block is self-contained: sequence + reporting + why-this-exists. Shared fallback + citation prose uses `{{TOOLS_CODE_RESEARCH_NAME}}` placeholders.
- **`/architecture-graph` skill parametrised.** Generation step 1 (enumerate boundaries) and Refresh step 2 (diff against code reality) carry per-tool blocks; the bind step resolves to the chosen tool's primitive.
- **`_core/project-template/CLAUDE.md` "BEFORE ANY CODE RESEARCH" + "TOKENSAVE ENTRY POINT" sections agnostified.** The two sections now reference `{{TOOLS_CODE_RESEARCH_NAME}}` and delegate per-tool command shapes to `/find`. The "TOKENSAVE ENTRY POINT" heading renamed to "CODE-RESEARCH ENTRY POINT".
- **`_core/project-template/.claude/rules/token-efficiency.md` "Read before writing" rule** simplified to "invoke `/find` first," delegating per-tool sequence to the skill. The boolean "If tokensave is installed / Otherwise" branch is gone.
- **`_core/project-template/.claude/skills/session-close/SKILL.md` Tokensave-adherence section** generalised to "Code-research adherence metric" — counts calls matching the chosen tool's primitive shape vs Grep/Glob fallbacks. Per-tool counting heuristic via `<!-- TOGGLE:code_research:<value> START/END -->` blocks.
- **`_core/global-template/CLAUDE.md.additions` rule heading** renamed from "No Explore Agents When Tokensave Is Available" to "No Explore Agents When the Project's Code-Research Tool Is Available". Per-tool guidance via `:code_research:<value>` blocks; the tokensave-specific tool list moved inside the `:tokensave` block.
- **`_core/global-template/README.md` verify question** rephrased from "tokensave-first rule" to "no-Explore-agents-for-code-research rule".
- **Configurator UI blurbs (index.html + redesign/data.jsx + index.legacy.html).** The `tokensave_entry_point` toggle's label, controls, and blurb fields now describe the agnostic semantics. The toggle ID is preserved (legacy — see "Known follow-ups" below).
- **Manifest entries** (index.legacy.html) updated: ships `code-research-first.py.template` + `code-research-profiles.json` instead of the old hand-coded `tokensave-first.py`.

### Removed
- **`_core/global-template/hooks/tokensave-first.py`** (orphan after the template+profile system supersedes it). The bind step renders the equivalent file from the template + tokensave profile.

### Also shipped — CI review-gate hardening + workflow maintenance (accumulated on `main` since v1.2.1)

The v1.3.0 tag is cut from `main`, which accrued these hotfixes during the v1.3.0 development window. They are documented here so the changelog matches what the tag ships. Where an item also has a **canonical-template** counterpart, that counterpart landed on `develop` only and ships in v1.4.0 (the mirror PR is cited inline per item) — **only the live-workflow half is in v1.3.0.**

**Two-tier review gate matured to its Checks-API architecture:**
- **Deep-tier verdict folded into the merge gate** (#83), then reframed as **two independent required status checks on the PR HEAD SHA via the Checks API** (#87) — `Evaluate review outcome` (routine) AND `Claude On-Demand` (deep), ANDed for merge.
- **`Claude On-Demand` lifecycle** walks `in_progress → skipped / success / failure` (#90); **fail-closed when Opus errors** without posting a verdict comment (#89).
- **Hardening invariants** (#97): stale-verdict floor on the routine gate, stale-comment floor on the deep-tier gate, terminal-state guard on the Resolve step, self-heal POST for `init-deep-check` failures. Plus a **terminal-state guard on the non-reviewable PATCH path** (#99).
- **`🟡 Uncertainty surfaced` section required in escalating verdicts** (#78).
- **`code_research` pre-screen placeholders registered in the canonical allowlist** (#76) — the live-workflow half of this release's headline feature.

**Reviewer-prompt + model maintenance (live-workflow half only):**
- **Routine reviewer prompt — FAIL-CLOSED verdict-emoji enforcement** (#105): the `Evaluate` parser is strict (`grep -E "🔴|🟢" | tail -n 1`), so bare `LGTM` is treated as a missing verdict. Added a WRONG-formats list (bare `LGTM`, wrong emoji, missing `— must fix` suffix) + a pre-post self-check. _(Canonical-template mirror: v1.4.0, #106.)_
- **On-demand deep-review model bumped Opus 4.7 → 4.8** in live `claude.yml` (#111), adopted as a watched trial. _(Canonical `claude.yml.template` mirror: v1.4.0, #112.)_
- **Review-workflow live labels de-versioned + placeholder tokens registered** (#113, #115): `REVIEW_DEEP_MODEL` / `REVIEW_ROUTINE_MODEL` / `STACK_COMMANDS_ALLOWLIST` added to the canonical placeholder allowlist; SETUP.md Phase 3 resolves the review-model tokens to deliberate stable defaults (`claude-opus-4-8` deep / `claude-sonnet-4-6` routine). Live `--model` literals stay concrete. _(Canonical template tokenization: v1.4.0, #116.)_
- **Orphaned `'TIMEZONE'` entry dropped from the canonical placeholder allowlist** (#107). _(Full end-to-end `{{TIMEZONE}}` removal across canonical templates + bind UI: v1.4.0, #104.)_

### Migration

**If you do NOT re-bind, nothing changes for you.** Your existing `~/.claude/hooks/tokensave-first.py` (hand-installed or installed by a prior bind) keeps working unchanged. The v1.3.0 patch updates only the canonical templates in this repo; nothing on your machine is touched until you re-run setup.

**To pick up the parametrised templates on an existing v1.2.1 bind:**
1. Re-download the configurator zip from https://starfoxcom.github.io/claude-code-templates/ with the same bundle + same `tools.code_research` value you previously chose.
2. Unzip at your project root (overwriting the prior `claude-code-templates/` folder is fine).
3. Paste the new `PASTE-TO-CLAUDE.md` content into Claude Code. Claude reads the bundled (or fetched) `SETUP.md`, walks through Phase 1 → Phase 7a, regenerates `.claude/skills/` + hook + CLAUDE.md sections against the new canonical.
4. The bind step asks before overwriting any file whose content diverges from the rendered output — your hand-edits in `~/.claude/hooks/tokensave-first.py` are preserved on a "no" answer.

**To switch tools** (e.g., from `tokensave` to `ast-grep`):
1. Re-run setup as above but pick the new `tools.code_research` value in the configurator UI.
2. The bind step:
   - Computes the new profile (`ast-grep` → `filename_basename: "ast-grep-first"`).
   - Renders the new `~/.claude/hooks/ast-grep-first.py`.
   - Adds the new matcher entry to `~/.claude/settings.json` (atomic write via `.tmp` + `os.replace` — never corrupts the file mid-write).
   - Detects the orphan `tokensave-first.py` entry, asks before removing it + deleting the file.
   - Re-resolves CLAUDE.md / `/find` / `/architecture-graph` / session-close adherence sections against `ast-grep` (per-tool blocks).
   - Updates the global CLAUDE.md additions section block.

**To switch to `none`** (no enforcement hook): pick `tools.code_research: "none"` and `tokensave_entry_point: false`. The bind step still runs the orphan cleanup — your stale `tokensave-first.py` registration is removed.

**Hook is advisory, not a security boundary** — it fails open on malformed input and unknown profile fields. Don't rely on it for sandboxing; rely on it for Claude-discipline.

### Known follow-ups (with target releases)

Consolidates open items from v1.0.0 / v1.1.0 / v1.2.x follow-ups + new items introduced in v1.3.0. Target versions reflect session-paced sequencing (AI does the code; user manages scope + design decisions); see the v1.3.0 roadmap conversation for rationale.

**v1.3.1 — patch**
- **`tokensave_entry_point` toggle rename to `code_research_first`** with backward-compat alias resolution (per `developer_branch`/`default_branch` precedent). Alias accepts the legacy name so existing bound projects keep working; future binds emit the new canonical. Shape pre-committed in SETUP.md Phase 1 step 4 — execution is mechanical.

**v1.4.0 — minor**
- **Extend per-value marker + tool-profile pattern to the `precommit` slot** (lefthook / husky / pre-commit / simple-git-hooks / none / Other). First additional slot using the v1.3.0-established pattern; derisks subsequent slot wirings + Audit mode (v1.5.0). Pattern documented in TOGGLES.md § "Adding a new tool slot".
- **Per-tool MCP server / CLI installation guidance.** The hook template assumes the chosen tool is already installed; doesn't install it. The setup summary should include a "to install `<tool>`: see `<url>`" hint sourced from each profile's `url` field. Trivial polish; bundles naturally with v1.4.0 since the precommit slot wiring also surfaces install hints.

**v1.5.0 — minor**
- **Audit/Optimize mode** (issue #3 — tracked since v1.2.1). New third SETUP mode (alongside Manual + Discovery) that reads existing `.claude/BIND.md` + project state, diffs against current templates, surfaces drift + proposes deltas. Heavy enough to be its own release. Needs a design decision before code: what's the user-facing trigger (re-paste bootstrap brief with `mode: "audit"`? Separate paste? Auto-detect from `.claude/BIND.md` presence?).

**v1.6.0 — minor**
- **Extend per-value markers + tool profiles to the `ci` slot** (GitHub Actions / GitLab CI / CircleCI / Jenkins / Buildkite / none / Other). Heavier than precommit because CI YAMLs differ substantially per vendor — needs per-tool workflow template files, not just per-value blocks. Design decision: ship full YAML translations for non-GitHub-Actions vendors, or stub them with a "translate this GH Actions workflow yourself" pointer?

**v1.7.0 — minor**
- **Telemetry Stop hook** (issue #4 — tracked since v1.2.1). Opt-in `~/.claude/hooks/telemetry-stop.py` writing session metadata. Design decision: local-file-only (privacy-safe default) vs also opt-in remote endpoint? Complements community-metrics path (v1.9.0).

**v1.8.0 — minor**
- **Extend per-value markers to the `ai_reviewer` + `issue_tracker` slots** (Claude / CodeRabbit / Bito / Sourcery / Codium / none / Other; GitHub / Linear / Jira / Notion / Shortcut / none / Other). Both are lower-priority — most users stick with the catalog defaults (Claude + GitHub) — wire for completeness and to close out the "all 4 remaining slots" backlog from v1.0.0's "Tool slot template wiring" entry.
- **'I want them all' bundle bypass** (issue #5 — tracked since v1.2.1). Configurator-level: add a "bypass bundle defaults — every toggle ON" mode with toggle-conflict detection. Bundles cleanly with the final slot wirings since it also touches the configurator UI.

**v1.9.0 — minor**
- **Community metrics aggregate** (issue #2 — tracked since v1.1.0). Opt-in, anonymized, PR-submitted before/after metrics. Heavy design conversation needed before code: what's collected, where it's submitted (GH issue? GH discussions? dedicated repo?), privacy review, schema versioning.

**v1.9.1 or later — patch**
- **`manifest.json` build script** (tracked since v1.1.0). `tools/build-manifest.py` autogenerates the resolved + source manifests from the repo tree on every commit; CI integration. Tooling polish — doesn't change product surface.

**v2.0.0 — major**
- **Drop the `tokensave_entry_point` alias** entirely. Time-gated, not effort-gated — wait until enough minor releases have shipped with the alias that judged-sufficient migration time has passed. No current driver.

**Out-of-band (not SemVer-versioned for the public toolkit)**
- **Routine + deep review workflows installation in this repo** (issue #1 — tracked since v1.2.1). Self-hosting CI that mirrors what the templates already ship to downstream users. Per the `workflow-changes-are-hotfixes` discipline, branches from `main` as `hotfix/install-workflows`. Lands any time independent of the public-toolkit version cadence.

### Versioning policy
- **Minor** release per the SemVer rules: wires an existing v1.0.0 promise (`tools.code_research` slot) through the canonical templates end-to-end, adds the per-value marker syntax + tool-profile JSON pattern, no toggle catalog renames / bundle key renames / manifest schema breaking changes. Downstream binds at v1.2.1 keep working — re-fetch templates to pick up the parametrised skills + hook profile system. Existing `tools.code_research: "tokensave"` users get an equivalent hook at the same filename path.
- **New configurator contract:** every `TOOL_SLOTS[<slot>].options[<i>]` entry now carries a `key` field (lowercase, profile-lookup-safe; falls back to `name.toLowerCase()` for compat). Third-party forks adding options to any tool slot MUST set `key` explicitly — `buildManifest()` emits `key` not `name` into `tools.<slot>`. This is additive (existing options keep working via the fallback) but contributors should set `key` going forward.

---

## [v1.2.1] — 2026-05-20

Security patch on top of v1.2.0. Closes a false-green gate vulnerability introduced when v1.2.0 removed the verdict timestamp cutoffs. No user-visible UI changes; no contract changes; templates-only consumers and the live gate both get the corrected mechanism.

### Security
- **HEAD-SHA verdict correlation closes false-green gate vulnerability.** v1.2.0 removed the timestamp cutoff from both verdict-read pipelines on the assumption that `cancel-in-progress: true` + `| last` + `--paginate` provided sufficient structural prevention of stale-verdict pickup. The reasoning covered the in-flight race case but missed the failure case: `cancel-in-progress` only cancels in-flight runs — it cannot un-post a verdict that an earlier completed run already wrote to the PR.

  **Attack path that shipped in v1.2.0:**
  1. Push A clean → routine review fires → 🟢 verdict posted.
  2. Push B: malicious `_core/` change + any trivial workflow-file touch (one-line comment edit).
  3. Push B's run hits `Workflow validation failed` — the Anthropic Claude Code GitHub App's OIDC token exchange refuses to authenticate when workflow files differ between the PR head and the default branch. This is **expected and documented** behavior for workflow-touching PRs (see `_core/project-template/.claude/rules/review-tiers.md` § "Workflow-touching PRs require admin-bypass").
  4. The action exits without posting any verdict comment. `Evaluate review outcome` still runs (`if: always()`), reads PR comments via `gh api --paginate | jq | last` → returns Push A's 🟢.
  5. Gate exits 0. Required-status-check passes. The maintainer's only remaining gate is manual approval — a false-green that LOOKS like an AI review pass can bypass scrutiny.

  **Fix.** Filter verdict comments by `created_at >= floor`, where `floor = min(.workflow_runs[].run_started_at)` across all workflow runs at the PR's current HEAD SHA. Mechanism:
  - Each evaluate job captures HEAD SHA (`github.event.pull_request.head.sha` for the routine gate, via the PR API for `claude.yml`'s `issue_comment`-fired deep gate).
  - Queries `/actions/runs?head_sha=$HEAD_SHA&per_page=100` with `--paginate`, computes the floor as `min(.workflow_runs[].run_started_at)`.
  - Filters the issue-comments query with `select(.created_at >= $floor)`.
  - Push A's verdict was posted under HEAD SHA A. The `actions/runs?head_sha=B` query doesn't include Run A. The floor is Run B's `run_started_at`. Push A's verdict (`created_at < floor`) is correctly rejected. Gate exits 1 with "No review comment found at or after HEAD-SHA floor". Merge blocked.

  **HEAD-SHA over `$GITHUB_RUN_ID`-based correlation:** generalises to multi-tier reads where the verdict is posted by a different workflow run than the one running the gate (e.g., a deep-tier fold-in pattern where the routine gate's evaluate step reads the deep verdict). Architectural-fit improvement caught by [GameProject's v1.2.0 port (PR #139)](https://github.com/starfoxcom/GameProject/pull/139) and cross-ported back here. Bidirectional cross-pollination steady-state.

  **Affected files** (live + canonical templates in lockstep):
  - `.github/workflows/claude-code-review.yml`
  - `.github/workflows/claude.yml`
  - `_core/project-template/.github/workflows/claude-code-review.yml.template`
  - `_core/project-template/.github/workflows/claude.yml.template`

  Each evaluate job gains `actions: read` permission for the `actions/runs` API query.

### Versioning policy
- **Patch** release per the SemVer rules: security fix to the gate mechanism, no toggle catalog / bundle keys / manifest schema / SETUP.md contract changes. Downstream binds existing at v1.2.0 should re-fetch templates to pick up the corrected gate.

---

## [v1.2.0] — 2026-05-20

CI hardening + canonical-template parity. The routine + deep review workflows reach their final hardened shape; the templates that ship to downstream binds catch up to that shape. Configurator branch-field rename closes a Gitflow incoherence bug. No user-visible UI rework — the configurator's form layout shifts but the contract is the same.

### Added
- **Substantive Python pre-screen on routine review.** `claude-code-review.yml`'s `Pre-screen PR diff` step now runs six deterministic checks before Sonnet sees the diff: toggle-marker balance (every `<!-- TOGGLE:name START -->` has a matching END in the same file), placeholder validation (every `{{NAME}}` in `_core/project-template/**` is in the canonical SETUP-resolvable set), AI-attribution scan (regex-based, applies to added lines only), JSX/HTML parity (`redesign/*.jsx` touched without `index.html` in the diff is a warning), file categorization (architecture-critical vs docs vs other code), and deep-trigger surface detection. Sonnet trusts the pre-screen and spends turns on judgment work — not re-discovering grep-able patterns. The `Bash(gh *),Read` action allowlist is sized exactly for this contract.
- **Triage blast-radius coverage.** The reviewable-files regex now catches `\.template$`, `^_core/` (rules, skills, templates), `\.additions$` (CLAUDE.md additions), and `/bundle\.toggles\.md$`. High-blast-radius non-code changes no longer slip past the routine review.
- **Task-tracking discipline with multi-PR pattern.** `_core/project-template/CLAUDE.md` documents the `TaskCreate` / `TaskUpdate({ addBlockedBy: [...] })` pattern for sessions with 3+ discrete work items. **Multi-PR workstreams** (hotfix cascades, large refactors split for review) create one task per PR up-front and chain dependencies via `addBlockedBy` so the task list mirrors the merge order — treating a 10-PR chain as ad-hoc work burns hours on out-of-sequence routing.

### Changed
- **Verdict timestamp cutoffs removed** (PR #62). Both `claude-code-review.yml` (25-min) and `claude.yml` (10-min) dropped the `select(.created_at >= $cutoff)` filter from their verdict-read `jq` pipelines. The original rationale held for the in-flight race case the cutoff was originally addressing (a slow Sonnet run on a large `_core/` diff creeping toward the 25-min cap and silently fail-red'ing the gate). **It missed the workflow-validation-failure case**: a later push that posts no verdict at all causes `| last` to fall back to a prior push's verdict, producing a false-green on the required gate. **v1.2.1 corrects this** with HEAD-SHA verdict correlation — see the v1.2.1 `### Security` entry for the full attack path and the floor-based fix. Canonical templates at `_core/project-template/.github/workflows/*.template` were cutoff-stripped here in v1.2.0; v1.2.1 brings the HEAD-SHA floor to all four files in lockstep.
- **Canonical workflow templates updated to live shape.** `_core/project-template/.github/workflows/{claude-code-review.yml.template, claude.yml.template}` now mirror the live workflows' v1.2.0 form — substantive Python pre-screen, two-job structure (`triage` + `evaluate-review-outcome`), SHA-pinned `claude-code-action@8c196b2f`, `--paginate` on verdict reads. As shipped in v1.2.0, the verdict reads used `| last` with no temporal filter; v1.2.1 added the HEAD-SHA floor to close the false-green gap described above. Downstream binds get the same gate this repo dogfoods.
- **`claude.yml` cleanup.** Removed the `issues:` trigger (the deep tier fires on PR comments only). Bot-loop guard switched from `contains` to `startsWith` on the `Claude Code is working` filter — `contains` rejected legitimate escalation comments that quoted the phrase later in the body, silently blocking the deep tier from firing on PRs that needed it. Added `allowed_bots: "claude"` to opt routine→deep escalations into the bot-trigger path explicitly. Advisory completion-evaluator step retained but corrected.
- **`--paginate` on both `gh api` verdict reads.** Without `--paginate`, PRs with >30 existing comments would put the verdict comment on a later page; the routine gate would silently fail-red and the deep tier's advisory gate would silently pass when a real 🔴 needed to surface.
- **AI-attribution scanner comment de-self-reference.** The pre-screen scanner's docstring previously reproduced the regex patterns from `ai_pats`, causing the scanner to flag itself on every workflow-file edit. Comment is now structural (points at `ai_pats` below); regexes remain the single source of truth.
- **`jq` constraint documented in `token-efficiency.md`.** Background-shell environments may not have the external `jq` binary (absent on Windows Git Bash, stripped-down containers; present on `ubuntu-latest` runners and most devcontainers). The canonical polling snippet uses `gh`'s built-in `--jq` flag instead, with a `python3 -c` fallback noted.
- **Template placeholder rename: `{{DEFAULT_BRANCH}}` → `{{DEV_BRANCH}}`** (#14). The old name collided with GitHub's UI "default branch" concept — the template meant "the dev integration branch where day-to-day work targets" (`develop` for Gitflow, `main` for trunk-based). `SETUP.md` retains a backwards-compat shim that accepts `developer_branch` / `default_branch` in older manifests with a warning.
- **Configurator form: branch fields simplified** (#14). The previous three-field setup ("Default branch" + "Developer branch" + optional "Production branch" override) collapsed into two clearer fields:
  - **Main branch** (required) — production / release branch. Tagged versions live here. Default `main`.
  - **Dev branch** (Gitflow only) — where day-to-day work targets and PRs base from. Default `develop`. Hidden when Branching model = Trunk-based.

  State variables renamed in `index.html` + `redesign/bind.jsx`: `default_branch` removed, `developer_branch` → `dev_branch`. Manifest schema emits `main_branch` + `dev_branch`.

### Fixed
- **Configurator produced incoherent binds for Gitflow projects** (#14). Bundle 2 (OSS, Gitflow) rules said "branch from develop / PR to develop", but the configurator's `default_branch` field carried the release-branch value and `SETUP.md` substituted `{{DEFAULT_BRANCH}}` from it — resolved skills said "PR to main" while rules said "PR to develop". Fixed by the rename + UI restructure above.
- **Session-start now reads the CONTEXT handoff file** (#9). The template's session-close skill writes `{{PROJECT_NAME_UPPER}}-CONTEXT_*.md` but session-start was ignoring it — the read/write loop was broken on the read side. Gated by `context_refresh_files: true` (OSS bundle default).
- **`index.html` `paths-ignore` toggle blurb wording** (PR #60). Mismatched description corrected; `redesign/bind.jsx` source updated to keep parity with the inlined HTML.
- **`.tokensave/` properly ignored.** Was creating phantom unstaged files in every clean checkout before the `.gitignore` update landed.

### Self-bind
- **Repo now self-bound** (#12). `.claude/skills/{session-start,session-close,find,architecture-graph}/SKILL.md` resolved from `_core/project-template/.claude/skills/` per `bundles/2-multi-dev-oss/bundle.toggles.md` + Discovery-mode resolution for null toggles. `.claude/BIND.md` documents the audit trail. The templates' own project finally dogfoods itself.

### Known follow-ups
- **Routine + deep review workflows installation in this repo** (issue #1). The canonical workflows live at `_core/project-template/.github/workflows/`, but this repo's `.github/workflows/` carries hand-authored variants. A consolidation pass to replace them with the canonical templates rendered against this project's placeholders is roadmap.
- **`/find` skill parametrisation** (issue #10). Currently names tokensave explicitly; should read `tools.code_research.name` from the bound config.
- **`'I want them all'` bundle bypass** (issue #5). Bundle bypass + toggle-conflict detection.
- **Audit/Optimize mode** (issue #3). Third mode for analyzing existing setup.
- **Telemetry Stop hook** (issue #4). Opt-in session metadata capture.
- **Community metrics** (issue #2). Opt-in, anonymised, PR-submitted before/after metrics aggregate.

---

## [v1.1.0] — 2026-05-16

UI redesign. Same configurator contract, new shell. React + Babel via pinned CDN; preserves the no-build-step deploy pattern.

### Added
- **React-based UI shell.** `index.html` now renders via React 18.3.1 + ReactDOM 18.3.1 (UMD, production builds) loaded from `unpkg.com` with `integrity` SHA-384 hashes and `crossorigin="anonymous"`. JSX is transpiled in-browser via `@babel/standalone@7.29.0` (same pinning + SRI). All four CDN scripts are version-pinned and SRI-attested; nothing is fetched at "latest" or unpinned.
- **`redesign/` dev source.** Nine `.jsx` modules (`data`, `tweaks-panel`, `bind`, `compare`, `toggles`, `howbinds`, `receipts`, `about`, `app`) plus a `redesign/index.html` dev shell. Each module is the un-bundled equivalent of a `<script type="text/babel" data-component="…">` block in the production `index.html`. Edit a single module during iteration; the bundled output mirrors the same code path.
- **Module markers.** Each inlined block in `index.html` is preceded by `<!-- ==== redesign/<filename>.jsx ==== -->` and tagged with `data-component="…"`. Grep for either to find any component in the single-file output.
- **Six folios.** I · Bind, II · Compare, III · Toggles, IV · How it binds, V · Receipts, VI · About. Folio V (Receipts) is fully baked from `_data/receipts_analysis.json` — 143 sessions across 36 days, with the four canonical receipts (abandoned-PR retros, largest-single-session, highest-tool-error, worst-day) surfaced.
- **Tweaks panel.** Dev-only sidebar surface exposing radius + accent-hue sliders. Gated behind the host's `tweaks` toggle; never shown to end users by default.
- **`index.legacy.html`.** The v1.0.0 landing page is preserved at the repo root as a fallback. GitHub Pages serves it at `/legacy.html` for use during any v1.1.0 deploy issue.

### Changed
- **JSZip CDN.** Switched from `cdn.jsdelivr.net` (v1.0.0) to `cdnjs.cloudflare.com` (v1.1.0) for JSZip 3.10.1, and added SRI `sha512-…` + `crossorigin="anonymous"` to the lazy-loaded script tag. Both providers are reputable; cdnjs aligned with the chosen SRI hash. v1.0.0 did not ship SRI on the JSZip include — adding it for v1.1.0 closes a small supply-chain hole.
- **Font stack.** Geist (v1.0.0) → Space Grotesk + Inter Tight + JetBrains Mono (v1.1.0). All Google Fonts; preconnect hints in `<head>` for both `fonts.googleapis.com` and `fonts.gstatic.com`.
- **Toggle catalog.** Now 36 toggles in 7 groups (was 32 in 6 groups). The data layer is canonical: any change here flows to every consuming view. Bundle defaults preserved across overlap.

### Fixed
- **Discovery-mode toggle promotion.** v1.0.0 promoted universally-off toggles (e.g. `clean_room_rule`, `dod_devlog_step`) to `ask` in the manifest when Discovery mode was active. The first cut of the redesign hid the toggles UI in Discovery but skipped the manifest-side promotion logic. Restored in `buildManifest()` so the contract the UI promises ("5 universally-off toggles will be promoted to ASK in Discovery") is what actually lands in the downloaded `manifest.json`.

### Versioning policy unchanged
- **Major** (`v1 → v2`): breaking change to the toggle catalog, the bundle keys, the manifest schema, or the SETUP.md contract.
- **Minor** (`v1.0 → v1.1`): new bundle, new toggle, new tool slot, new UI capability — additive, fully backward-compatible. ← **this release**
- **Patch** (`v1.0.0 → v1.0.1`): bug fixes, copy edits, design polish without behavior change.

### Known follow-ups
- **Community metrics (issue #2).** Opt-in, anonymised, PR-submitted before/after metrics aggregate. Tracked for v1.2.
- **`manifest.json` build script.** Still hand-curated; auto-generation from the repo tree is roadmap.
- **`/find` skill parametrisation.** Currently names tokensave explicitly; should read `tools.code_research.name` from the bound config.

---

## [v1.0.0] — 2026-05-15

First public release. Toggle-driven configurator, in-browser bind generator, GitHub Pages deployment, full self-application.

### Added
- **In-browser bind-volume generator.** `index.html` assembles a downloadable zip via JSZip, applies `<!-- TOGGLE:key START/END -->` filtering inline, and produces `claude-code-templates-<bundle>-v1.0.0.zip` directly. Two manifests: **resolved** (manual mode, ready-to-commit) and **source** (discovery mode, full templates + `bundle.json` + `DISCOVERY-PROMPT.md` for Claude to read).
- **Modern app aesthetic.** OKLCH color system with dark default + light mirror, layered shades for depth (5 background tiers), Geist (sans + mono), 0.25rem spacing scale, smooth motion. Theme toggle persists.
- **Responsive layout.** Mobile-first single-column at < 640px; bundle grid 2-up at 560px; sidebar nav at 1024px; bundle grid 4-up at 1180px.
- **Discovery mode.** Pick a bundle as the baseline; Claude infers project metadata + non-default toggle overrides by inspecting the repo. Universally-off toggles (specialised rules like `clean_room_rule`, `dod_devlog_step`) are promoted to *ask* in Discovery so Claude evaluates them against your context. No `git clone` required — the discovery zip ships full source templates.
- **Tool slot abstraction.** Five user-pluggable slots in the configurator: `code_research` (tokensave / ast-grep / Sourcegraph / ctags / Semgrep / none / other), `precommit` (lefthook / husky / pre-commit / simple-git-hooks / none / other), `ci` (GitHub Actions / GitLab CI / CircleCI / Jenkins / Buildkite / none / other), `ai_reviewer` (Claude / CodeRabbit / Bito / Sourcery / Codium / none / other), `issue_tracker` (GitHub / Linear / Jira / Notion / Shortcut / none / other). Each slot has an "Other (specify)" escape hatch. Rule files reference these names at bind time so the templates don't lock users into one vendor.
- **`VERSION` file** at repo root. Discoverable from inside any unzipped bundle.
- **Public-facing `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `CHANGELOG.md`.**
- **GitHub Pages deployment** via `.github/workflows/pages.yml` at `https://starfoxcom.github.io/claude-code-templates/`.
- **Self-application.** Project root `CLAUDE.md` + `.claude/settings.local.json`; references canonical rules in `_core/project-template/.claude/rules/` rather than duplicating them.

### Changed
- **`tokensave-first.py` hook** rewritten to be Python 3.5+ compatible. The previous `pathlib.Path | None` PEP 604 union syntax required Python 3.10+ and silently crashed on Windows machines where `py` resolved to 3.9 — leaving enforcement inert despite the hook firing.
- **Hook install path documented as global-only** in `_core/global-template/hooks/tokensave-first.py` and `_core/project-template/CLAUDE.md`. Project-local installation triggers a tokensave template-inheritance bug that corrupts settings on every Stop event.
- **Modified-toggle indicator** clears when the user cycles a toggle back to its bundle default (previously stuck on after first change).
- **Step order:** the Discovery panel now sits *after* the Bundle picker — the user picks the bundle first (which becomes the discovery baseline), then sees what's skipped.

### Removed
- `START-HERE.html` — superseded by `index.html`.

### Fixed
- The hook traceback that surfaced as `PreToolUse:Bash hook error — Failed with non-blocking status code` in Claude Code sessions on Windows.

### Known follow-ups
- **Tool slot template wiring.** The data layer ships in v1.0.0; full per-tool template variants (e.g. GitLab CI YAMLs, husky configs, Linear issue templates) land iteratively. Claude adapts at bind time using the chosen slot names; for known tools the canonical templates ship; for "other / custom" Claude asks during apply.
- **`manifest.json` build script.** The bundler currently uses a hand-curated fallback manifest. A `tools/build-manifest.py` script that auto-generates `manifest.resolved.json` and `manifest.source.json` from the repo tree on every commit is roadmap.
- **`/find` skill parametrisation.** The skill currently names tokensave explicitly. It should read `tools.code_research.name` from the bound config and use that.

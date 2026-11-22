# Bindwright

Bindwright sets a repo up for agentic coding: the rules, session skills, guard hooks and review workflows that fit the project, chosen from a few questions it asks in the session. It keeps them current afterwards without overwriting your own edits.

## Install

From the wrights marketplace (`starfoxcom/wrights`), which lists Bindwright and FindWright, in a Claude Code session:

```
/plugin install bindwright --marketplace starfoxcom/wrights
```

Once its plugin directory listing is approved, Bindwright also installs from `/plugin`, then Discover, and from the Claude desktop app's plugins screen.

Then open a session in your project's folder and run `/bindwright:setup`. The first time, it installs Bindwright's helper, the part that runs on your computer (its setup engine, templates and scripts): the files attached to the plugin's GitHub release (one for Node, one for a computer with Python and no Node), checked against the SHA-256 the plugin pins, into `~/.bindwright/helper` for your user only, and says so in one line; `/bindwright:update` keeps the helper at the plugin's version.

## Use

- `/bindwright:setup` asks how you want to work and writes the setup into the repo you are in. Questions about your whole computer come only the first time; questions about the project come every time. Files the repo already has are staged for you to merge, never overwritten.
- `/bindwright:setup global` asks the computer questions again.
- `/bindwright:code-style` reads code you wrote by hand, in your local repos and your GitHub account, with your permission, and saves a short profile of how you write code, with the weak spots brought up to current practice, which every session then follows.
- `/bindwright:update` brings a set-up repo up to the plugin's current templates and keeps your edits.
- `/bindwright:remove` takes the setup back out of a repo and the extras out of your config folder, keeping every file you changed, and ends with how to uninstall the plugin; `/bindwright:remove computer` does only the config folder.
- `/bindwright:export` records which extras the team expects; `/bindwright:join` brings a teammate's machine in line after cloning.
- `/bindwright:local-runners` checks your computer and the repo's CI, recommends how many local CI runners to set up (or none), and installs the ones you pick.
- `/bindwright:review-trial` compares models for the repo's AI review on its own merged pull requests, within what your plan includes, shows the cost before anything runs, and recommends whether to change the review settings.

When a session starts with `/start-session`, a notice says at most once a day when the repo or the plugin is behind.

## Examples

- "Set this repo up for agentic coding." Runs `/bindwright:setup`: it asks about the project (language, how releases are numbered, whether pull requests get an AI review), shows every file it will write and every change outside the repo, and writes them on your yes.
- "Bring this repo's setup up to date." Runs `/bindwright:update`: it rebuilds the files from your saved answers with the current templates, keeps the edits you made, and stages any file where both changed the same lines for you to settle.
- "Something in the setup isn't working." Runs `/bindwright:doctor`: it checks the repo and the computer and says in plain words what is wrong and how to fix each thing, changing nothing.
- "Take Bindwright back out of this repo." Runs `/bindwright:remove`: it removes what setup wrote, keeps every file you changed, and ends with how to uninstall the plugin.

## What setup changes

Setup shows the full list before it writes anything, and writes nothing without your yes. In the repo, it writes the files you picked: rules and session skills under `.claude/`, guard hooks, and, for GitHub, the review workflows and their scripts under `.github/`.

Some of what you pick changes how Claude Code behaves in later sessions, which is the point of it, so each piece is asked one at a time:

- **Rules and session skills** in the repo, which Claude Code reads in every session there.
- **Guard hooks**, small scripts Claude Code runs before some commands, such as one that refuses a commit carrying an AI-attribution line.
- **Extras for your whole computer**, in `~/.claude`: global instructions in `CLAUDE.md`, a push guard for every project, session titles, the builder agent, a code-style profile, a plain reply style, and mods (small add-ons that show the time and context use, watch CI, keep the task list current and similar).
- **The code-search tool, FindWright**, a separate plugin from the same wrights marketplace, installed and set up by its own setup. Once it has indexed a repo, its hook sends searches there to its tools instead of Grep and Glob.

Outside those, setup turns on Claude Code's auto-update for the wrights marketplace, so new versions of its plugins arrive by themselves; `/bindwright:setup global` turns it off.

All of it is plain text you can read and edit. `/bindwright:remove` takes it back out, auto-update included, with two exceptions it names as it runs: FindWright stays, since other tools may use it (`/findwright:remove` takes it out), and so does the setting that turns on Claude Code's own task tools, which the tasks mod needs. The scripts come from the helper, which is installed from this plugin's own GitHub release and checked against the SHA-256 the plugin pins; when the plugin updates, the helper follows to the version the new plugin pins, checked the same way. Apart from the helper and FindWright, setup downloads nothing that changes how Claude Code behaves.

## Troubleshooting

- Run `/bindwright:doctor` first: it names what is wrong and how to fix it.
- When the doctor points at Bindwright itself, `/bindwright:report` drafts a bug report, takes out paths, names, emails and tokens, shows it to you in full, and files it on GitHub only on your yes.
- Questions and bugs also go to the issues at https://github.com/starfoxcom/bindwright/issues.

## Privacy

The plugin sends nothing about you or your code. It makes five kinds of network call of its own:

- **The helper install**, after your yes, downloads the helper file the plugin pins from the plugin's release at `github.com/starfoxcom/bindwright/releases`.
- **The helper follow** (the helper's `hooks/follow.mjs`), at `/start-session` once the plugin has moved ahead of its helper, downloads the file the new plugin pins from the same place and installs it without asking, checked against its SHA-256; after a failure it tries again at most once a day.
- **The version check** (the helper's `hooks/notice.mjs`) reads one version number a day from `https://raw.githubusercontent.com/starfoxcom/bindwright/main/VERSION`.
- **The tool release check** (the helper's `hooks/tool-versions.mjs`), when setup or `/bindwright:doctor` runs, reads the newest release numbers of the tools this computer has: Node from `nodejs.org` and its release schedule from `raw.githubusercontent.com`, Git for Windows, the GitHub CLI and uv from GitHub's API, and the Claude Code CLI from the npm registry.
- **Review counts** (the helper's `hooks/counts.mjs`) are off unless you say yes at setup. Then, once a day, each project you picked sends a random id, a project kind, eleven numbers (review counts, red review rounds, rebuilds and dropped pull requests) and the time span they cover to `https://bindwright-counter.starfoxcom.workers.dev`, a Cloudflare Worker that also keeps the country Cloudflare reads from the connection. To count, it reads your own merged pull requests, and those closed without merging that carry a `dropped:` label, with the GitHub CLI already on your computer; nothing else leaves your computer, your code included.

Setup itself may run the install commands you approve (Git, Node or Python) and `gh` commands on your repo when you pick GitHub features. The full list of network calls is in the [README](https://github.com/starfoxcom/bindwright#privacy).

## Needs

Claude Code 2.1.295 or later, Git, and Node 18 or Python 3.8 or later to run the helper; setup says what is missing and how to install it on your system. The optional extras (global instructions, a push guard for every project, session titles, the builder agent, a code-style profile, a plain reply style and mods for `~/.claude`) are each asked once with a yes or no, and the work language (English or Spanish) once too, all saved in `~/.claude/bindwright/settings.json`. Outside the repo, nothing changes without a yes except two things that keep Bindwright current: setup turns on Claude Code's auto-update for the wrights marketplace (`/bindwright:setup global` turns it off), and the helper follows the plugin to each new version.

## License

The plugin is MIT. The files setup writes into your project are MIT-0, so you owe no credit for them.

Bindwright works with Claude Code. It is not made by, endorsed by or affiliated with Anthropic.

Page: https://starfoxcom.github.io/bindwright/

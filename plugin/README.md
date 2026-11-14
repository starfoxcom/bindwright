# Bindwright

Bindwright sets a repo up for agentic coding: the rules, session skills, guard hooks and review workflows that fit the project, chosen from a few questions it asks in the session. It keeps them current afterwards without overwriting your own edits.

## Install

From the plugin directory: in Claude Code, run `/plugin`, open Discover and install Bindwright; in the Claude desktop app, install it from the plugins screen. Or from the wrights marketplace (`starfoxcom/wrights`), which lists Bindwright and FindWright, in a Claude Code session:

```
/plugin install bindwright --marketplace starfoxcom/wrights
```

Then open a session in your project's folder and run `/bindwright:setup`. The first time, it asks to install Bindwright's helper, the part that runs on your computer (its setup engine, templates and scripts): the files attached to the plugin's GitHub release (one for Node, one for a computer with Python and no Node), checked against the SHA-256 the plugin pins, into `~/.bindwright/helper` for your user only. Say yes and setup goes on; `/bindwright:update` keeps the helper at the plugin's version.

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

## Privacy

The plugin sends nothing about you or your code. It makes four kinds of network call of its own:

- **The helper install**, after your yes, downloads the helper file the plugin pins from the plugin's release at `github.com/starfoxcom/bindwright/releases`.
- **The version check** (the helper's `hooks/notice.mjs`) reads one version number a day from `https://raw.githubusercontent.com/starfoxcom/bindwright/main/VERSION`.
- **The tool release check** (the helper's `hooks/tool-versions.mjs`), when setup or `/bindwright:doctor` runs, reads the newest release numbers of the tools this computer has: Node from `nodejs.org` and its release schedule from `raw.githubusercontent.com`, Git for Windows, the GitHub CLI and uv from GitHub's API, and the Claude Code CLI from the npm registry.
- **Review counts** (the helper's `hooks/counts.mjs`) are off unless you say yes at setup. Then, once a day, each project you picked sends a random id, a project kind, six numbers (review counts and red review rounds) and the time span they cover to `https://bindwright-counter.starfoxcom.workers.dev`, a Cloudflare Worker that also keeps the country Cloudflare reads from the connection. To count, it reads your own merged pull requests with the GitHub CLI already on your computer; nothing else leaves your computer, your code included.

Setup itself may run the install commands you approve (Git, Node or Python) and `gh` commands on your repo when you pick GitHub features. The full list of network calls is in the [README](https://github.com/starfoxcom/bindwright#privacy).

## Needs

Git, and Node 18 or Python 3.8 or later to run the helper; setup says what is missing and how to install it on your system. The optional extras (global instructions, a push guard for every project, session titles, the builder agent, a code-style profile, a plain reply style and mods for `~/.claude`) are each asked once with a yes or no, and the work language (English or Spanish) once too, all saved in `~/.claude/bindwright/settings.json`; nothing outside the repo changes without a yes.

## License

The plugin is MIT. The files setup writes into your project are MIT-0, so you owe no credit for them.

Bindwright works with Claude Code. It is not made by, endorsed by or affiliated with Anthropic.

Page: https://starfoxcom.github.io/bindwright/

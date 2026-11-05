# Bindwright

Bindwright sets a repo up for agentic coding: the rules, session skills, guard hooks and review workflows that fit the project, chosen from a few questions it asks in the session. It keeps them current afterwards without overwriting your own edits.

## Install

In a Claude Code session, once per computer:

```
/plugin install bindwright --marketplace https://starfoxcom.github.io/bindwright/.claude-plugin/marketplace.json
```

In the Claude desktop app, where `/plugin` does not run, the page's Install section has a line to paste into the chat instead.

## Use

- `/bindwright:setup` asks how you want to work and writes the setup into the repo you are in. Questions about your whole computer come only the first time; questions about the project come every time. Files the repo already has are staged for you to merge, never overwritten.
- `/bindwright:setup global` asks the computer questions again.
- `/bindwright:code-style` reads code you wrote by hand, in your local repos and your GitHub account, with your permission, and saves a short profile of how you write code, with the weak spots brought up to current practice, which every session then follows.
- `/bindwright:update` brings a set-up repo up to the plugin's current templates and keeps your edits.
- `/bindwright:export` records which extras the team expects; `/bindwright:join` brings a teammate's machine in line after cloning.
- `/bindwright:runners` checks your computer and the repo's CI, recommends how many local CI runners to set up (or none), and installs the ones you pick.

A notice at session start, at most once a day, says when the repo or the plugin is behind.

## Privacy

The plugin sends nothing about you or your code. It makes two kinds of network call of its own:

- **The version check** (`hooks/notice.mjs`) reads one version number a day from `https://raw.githubusercontent.com/starfoxcom/bindwright/main/VERSION`.
- **Review counts** (`hooks/counts.mjs`) are off unless you say yes at setup. Then, once a day, each project you picked sends a random id, a project kind, six numbers (review counts and red review rounds) and the time span they cover to `https://bindwright-counter.starfoxcom.workers.dev`, a Cloudflare Worker that also keeps the country Cloudflare reads from the connection. To count, it reads your own merged pull requests with the GitHub CLI you are already signed in to; no token or code leaves your computer.

Setup itself may run the install commands you approve (Git, Node or Python) and `gh` commands on your repo when you pick GitHub features. The full list of network calls is in the [README](https://github.com/starfoxcom/bindwright#privacy).

## Needs

Git, and Node 18 or Python 3.8 or later to run the setup engine; setup says what is missing and how to install it on your system. The optional extras (global instructions, a push guard for every project, the builder agent, a code-style profile, a plain reply style and mods for `~/.claude`) are each asked once with a yes or no, and the work language (English or Spanish) once too, all saved in `~/.claude/bindwright/settings.json`; nothing outside the repo changes without a yes.

## License

The plugin is MIT. The files setup writes into your project are MIT-0, so you owe no credit for them.

Bindwright works with Claude Code. It is not made by, endorsed by or affiliated with Anthropic.

Page: https://starfoxcom.github.io/bindwright/

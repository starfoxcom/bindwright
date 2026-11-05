# Bindwright

> **Live: [starfoxcom.github.io/bindwright](https://starfoxcom.github.io/bindwright/)**
>
> A Claude Code plugin that writes the files Claude Code reads about your project, so it knows how you work from the first message.

---

## What it does

`/bindwright:setup` asks a few questions in the session and writes the setup that fits the project: rules Claude Code reads at the start of every session, session skills that start with a plan and end with a hand-off, guard hooks that block force pushes and AI attribution, and CI workflows that put an AI review on every pull request. Questions about your computer come once; questions about the project come in every project. Files the repo already has are staged for you to merge, never overwritten.

Each rule here came from a real cost in a real project: the page's "What it caught in real projects" section shows the numbers and the mistakes that became rules.

## Install

In Claude Code, once per computer:

```
/plugin install bindwright --marketplace https://starfoxcom.github.io/bindwright/.claude-plugin/marketplace.json
```

In the Claude desktop app, where `/plugin` does not run, paste this into a Code tab chat instead, then start a new session once Claude says it is done (if `/bindwright:setup` is not there yet, give it a minute and start one more):

```
Install the Bindwright plugin for me: run claude plugin install bindwright --marketplace https://starfoxcom.github.io/bindwright/.claude-plugin/marketplace.json in the shell. If the claude command is not found, add the same marketplace (named bindwright, a url source at that address) under extraKnownMarketplaces and "bindwright@bindwright": true under enabledPlugins in my user settings file, ~/.claude/settings.json, keeping everything else in it.
```

Installing needs nothing else. Setup needs Git, and Node 18 or Python 3.8 or later; it says what is missing and offers to install it. Then, in each project, open Claude Code in the project's folder and run:

```
/bindwright:setup
```

The page's Install section says what each command changes on your computer and in the project; [plugin/README.md](plugin/README.md) lists the plugin's other commands.

## Repo layout

```
bindwright/
├── index.html              ← redirects the GitHub Pages root to page/
├── page/                   ← the live page (plain HTML, CSS and JS, no build step)
├── engine/                 ← the bind engine the plugin and the page's file preview run
├── plugin/                 ← the Claude Code plugin (/bindwright:setup)
├── _core/                  ← canonical templates (source of truth)
│   ├── project-template/   ← lands in your project root
│   ├── global-template/    ← lands in ~/.claude
│   └── licenses/           ← LICENSE template variants
├── tools/                  ← packing, page generation and the evidence counts
├── docs/                   ← plans and research
├── README.md               ← this file
├── CHANGELOG.md            ← version history
├── CONTRIBUTING.md         ← how to PR / what's in scope
├── LICENSE                 ← MIT
└── VERSION                 ← current version
```

## Versioning

[SemVer](https://semver.org/).

- **Major:** a breaking change to the saved answers (`.bindwright/project.json`) or to the files a set-up project depends on.
- **Minor:** a new setting, tool option, mod or command, fully backward-compatible.
- **Patch:** bug fixes, copy edits and design polish without behavior change.

See [CHANGELOG.md](CHANGELOG.md) for what shipped when.

## Privacy

The plugin writes only into the project you run it in and, for the extras you say yes to, into `~/.claude`. The page is static HTML and JavaScript on GitHub Pages, with no cookies and no analytics; its file preview runs the bind engine in your browser. Every network call either makes:

| Call | What it sends | When | How to stop it |
|---|---|---|---|
| Plugin version check | A plain request for the released version number from `raw.githubusercontent.com`; nothing about you or the repo | At most once a day, at session start | Disable the plugin (`/plugin`) |
| Review counts, opt-in | A random project id, the project kind you picked, and six numbers: your merged pull requests that the AI review checked, caught a problem in, sent to a deeper review, held back 6 or more rounds, and merged, plus the red review rounds summed over them, with the start and end time of the span they cover. The first send covers the project's past pull requests; a history past 500 goes out in daily batches only if you say yes. Cloudflare sees your IP address for its rate limiter; the counter never stores it, only the country Cloudflare reads from it, and publishes just how many projects each country has ([`counter/`](counter/README.md)) | At most once a day per set-up repo, only after a yes at setup | `/bindwright:setup global`, or `node <plugin folder>/hooks/counts.mjs share off` |
| GitHub, through your own `gh` login | The counts read your merged pull requests; setup and `/bindwright:code-style` read and create what you ask for (repos, boards, issues) | When that step runs | Answer no to the step |
| Code-search tool, when you install it | tokensave has an anonymous usage counter of its own, on by default; see its [privacy guide](https://github.com/aovestdipaperino/tokensave/blob/main/docs/guide/PRIVACY.md) | tokensave's own schedule | tokensave's own setting |
| The page | Reads the community totals from the counter, and its fonts from Google Fonts | On page load | Nothing to stop: it sends nothing about you |

## Maintenance & contributing

Solo-maintained as an open-source side project. Issues and pull requests welcome on a best-effort basis. See [CONTRIBUTING.md](CONTRIBUTING.md) for what's in scope and what's not.

## Security and conduct

Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes. Participation follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

The repo is MIT — see [LICENSE](LICENSE). The files setup writes into your project are [MIT-0](LICENSE-MIT-0), so you owe no credit for them.

Bindwright works with Claude Code. It is not made by, endorsed by or affiliated with Anthropic.

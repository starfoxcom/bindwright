# Bindwright

> **Live: [starfoxcom.github.io/claude-code-templates](https://starfoxcom.github.io/claude-code-templates/)**
>
> A Claude Code plugin that writes the files Claude Code reads about your project, so it knows how you work from the first message.

---

## What it does

`/bindwright:setup` asks a few questions in the session and writes the setup that fits the project: rules Claude Code reads at the start of every session, session skills that start with a plan and end with a hand-off, guard hooks that block force pushes and AI attribution, and CI workflows that put an AI review on every pull request. Questions about your computer come once; questions about the project come in every project. Files the repo already has are staged for you to merge, never overwritten.

Each rule here came from a real cost in a real project: the page's "What it caught in real projects" section shows the numbers and the mistakes that became rules.

## Install

In Claude Code, once per computer:

```
/plugin marketplace add starfoxcom/claude-code-templates
/plugin install bindwright@bindwright
```

Then, in each project, open Claude Code in the project's folder and run:

```
/bindwright:setup
```

The page's Install section says what each command changes on your computer and in the project; [plugin/README.md](plugin/README.md) lists the plugin's other commands.

## Repo layout

```
claude-code-templates/
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

The page is static HTML and JavaScript on GitHub Pages: no cookies, no analytics, no tracking. Its file preview runs the bind engine in your browser on files from the same site. The plugin sends nothing anywhere; it writes only into the project you run it in and, for the extras you say yes to, into `~/.claude`.

## Maintenance & contributing

Solo-maintained as an open-source side project. Issues and pull requests welcome on a best-effort basis. See [CONTRIBUTING.md](CONTRIBUTING.md) for what's in scope and what's not.

## License

MIT — see [LICENSE](LICENSE).

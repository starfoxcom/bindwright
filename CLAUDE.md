# CLAUDE.md — Bindwright

This repo is Bindwright itself, and it runs on its own setup. `.claude/rules/` is the bind the engine renders from `_core/project-template/.claude/rules/` with this project's answers in `.bindwright/project.json`, exactly what a downstream project gets. The canonical templates live only in `_core/`.

After a change in `_core/`, re-bind with `node engine/cli.js --update .` (the same three-way merge `/bindwright:update` runs, against `.bindwright/pristine.json`) and commit the result with it. Two hand tunes stay on top of the render: `code-size.md` lists only JavaScript and Python, and `collaboration.md` § Who reviews describes the solo-maintainer gate. `guard-hooks.md` and `templates.md` are this repo's own, with no template behind them: the first loads when a session opens a guard hook or its tests, the second when it opens a file under `_core/project-template/`.

## Project overview

**Bindwright** is an open-source Claude Code plugin: `/bindwright:setup` asks a few questions and writes the setup that fits the project. A landing page on GitHub Pages explains and installs it.

- **Live page:** `page/`, deployed at https://starfoxcom.github.io/bindwright/ (the root `index.html` redirects there). Hand-authored, no build step.
- **Templates:** `_core/`. **Bind engine:** `engine/`, run by the plugin (`plugin/`) and by the page's file preview.
- **Versioning:** SemVer, in `VERSION` and `CHANGELOG.md`; `.claude/rules/releases.md` holds the release flow.

## Review discipline: strict, because the bundle ships to every user

Downstream projects install these templates verbatim, so a malicious change landing on `main` would reach every future bind. The rules in `review-tiers.md` and `collaboration.md` apply with extra strictness:

- Required checks on `main` and `develop`: `Review gate` and `No AI attribution`; on `develop` also `Engine and hook tests` and `Mod tests`, which run on every PR. Zero required approvals, and no bypass actors: nobody, admins included, merges past the gates. Never `gh pr merge --admin`; `BLOCKED` means find and fix the cause.
- The deep review fires by itself on any PR touching `_core/` (its hooks included) or `engine/`, the surfaces with the widest reach.
- Our own PRs merge on green without waiting for the maintainer. A PR carrying a commit from outside our sessions also needs the maintainer's read of its whole diff.
- A PR that edits `.github/workflows/claude-code-review.yml` holds only that file and merges as `.claude/rules/review-workflow.md` says.
- `.claude/` and any `CLAUDE.md` or `AGENTS.md` always get a review, even in an otherwise docs-only PR. A PR title is at most 64 characters, since it becomes the merge commit's subject.

The live `claude-code-review.yml` and `claude.yml` are the resolved bind of `_core/project-template/.github/workflows/*.yml.template`.

## Session ritual

`/start-session`, `/close-session` and `/find` live in `.claude/skills/`. Work state lives on the GitHub board (`starfoxcom/6`) and in each issue's `### Current state` (`.claude/rules/tracker.md`); `/close-session` also rewrites the git-ignored `.bindwright/handoff.md`. This repo's extra steps (the review gate's `--check` at session start) are in `.bindwright/session-steps.md`.

## Repo layout

```
page/        the live page          engine/   the bind engine
plugin/      the plugin's skills    helper/   the helper package's scripts
_core/       project-template/ (lands in a user's repo), global-template/ (lands in ~/.claude), licenses/
counter/     the review-counts worker (Cloudflare)
tools/       packing, page and release scripts, and the guard-hook tests
docs/        maintainer docs        .github/  workflows, gate scripts, review guide
```

## Project conventions

- All code and prose in English.
- The page is plain HTML, CSS and JavaScript modules: no build step, no minification, readable in dev tools. OKLCH for colour; Hubot Sans and Fragment Mono from Google Fonts via `<link>`. No npm or bundling on the page.

# Review guide

The project's own part of the review prompt. Both review tiers read this file from the PR's base branch, so a PR cannot change the guide its own review follows, and every change to it gets a review.

## About this project

**claude-code-templates** is the open-source toolkit that ships Bindwright, a plugin that sets projects up for Claude Code. The bind engine and the canonical templates here become the binds every downstream user installs verbatim, so the review surface is load-bearing in a way ordinary OSS isn't.

## Project invariants to verify (in priority order)

1. **Canonical template integrity**: anything in `_core/project-template/**` lands verbatim in every downstream bind. Toggle markers (`<!-- TOGGLE:name START/END -->`) must be balanced; placeholders (`{{MAIN_BRANCH}}`, `{{DEV_BRANCH}}`, `{{PROJECT_NAME}}`, etc.) must be the canonical names the engine fills or defers to the plugin's setup (`engine/model.js` `valuesFor` and `DEFERRED`). A missing END marker silently swallows downstream content.
2. **Workflow template parity**: `_core/project-template/.github/workflows/*.template` should behave like this repo's live workflows after substitution. Drift between live and canonical means downstream binds get a different gate than this repo dogfoods.
3. **Hook safety**: `_core/project-template/.claude/hooks/**` runs on every user's machine. Any Bash / shell / Python edit there must be cross-platform (Linux/macOS/Windows-Git-Bash), POSIX-portable, and never assume a specific PATH or interpreter.
4. **The page (`page/`)**: its file preview runs `engine/bind.js` on the real `_core/` files, never a hand-made copy. English text lives in the HTML; a change to it adds the same key to every other language's dictionary in `page/i18n/` and regenerates the translated pages with `node tools/page_languages.mjs`.
5. **Setup defaults and questions (`engine/model.js`, `plugin/skills/setup/SKILL.md`)**: every default answer must be defensible, and each question must say what it changes on the computer or in the project.
6. **Versioning policy**: major/minor/patch matches the rules in `CHANGELOG.md`. New setting or tool option = minor. Bug fix / copy edit = patch. Breaking schema change = major.
7. **No AI-attribution markers**: per `_core/project-template/.claude/rules/git.md`, never `Co-Authored-By: Claude`, never "Generated with Claude Code" footers, never claude.com links in PR bodies or commit messages.

## Also escalate when the diff includes

These escalate on their own: the gate's own files in every project (`.github/scripts/**`, `.github/review-gate.yml`, this guide, the review workflows and the project's check folder), and this repo's trigger paths in `.github/review-gate.yml` (`escalate.paths`: `_core/`, `engine/`). Mark these for escalation too:

- Default answer changes in `engine/model.js`
- Changes to what `plugin/skills/setup/SKILL.md` asks or installs
- `_core/project-template/.github/workflows/*.template` (canonical CI)

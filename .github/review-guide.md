# Review guide

The project's own part of the review prompt. Both review tiers read this file from the PR's base branch, so a PR cannot change the guide its own review follows, and every change to it gets a review.

## About this project

**Bindwright** is the open-source plugin that sets projects up for Claude Code. The bind engine and the canonical templates here become the binds every downstream user installs verbatim, so the review surface is load-bearing in a way ordinary OSS isn't.

## Project invariants to verify (in priority order)

1. **Canonical template integrity**: anything in `_core/project-template/**` lands verbatim in every downstream bind. Toggle markers (`<!-- TOGGLE:name START/END -->`) must be balanced; placeholders (`{{MAIN_BRANCH}}`, `{{DEV_BRANCH}}`, `{{PROJECT_NAME}}`, etc.) must be the canonical names the engine fills or defers to the plugin's setup (`engine/model.js` `valuesFor` and `DEFERRED`). A missing END marker silently swallows downstream content.
2. **Workflow template parity**: `_core/project-template/.github/workflows/*.template` should behave like this repo's live workflows after substitution. Drift between live and canonical means downstream binds get a different gate than this repo dogfoods.
3. **Hook safety**: `_core/project-template/.claude/hooks/**` runs on every user's machine. Any Bash / shell / Python edit there must be cross-platform (Linux/macOS/Windows-Git-Bash), POSIX-portable, and never assume a specific PATH or interpreter.
4. **The page (`page/`)**: its file preview runs `engine/bind.js` on the real `_core/` files, never a hand-made copy. English text lives in the HTML; a change to it adds the same key to every other language's dictionary in `page/i18n/` and regenerates the translated pages with `node tools/page_languages.mjs`.
5. **Setup defaults and questions (`engine/model.js`, `plugin/skills/setup/SKILL.md`)**: every default answer must be defensible, and each question must say what it changes on the computer or in the project.
6. **Versioning policy**: the `[Unreleased]` entry's section matches `CONTRIBUTING.md` § Versioning: a change a user must act on goes under `### Breaking` (a major), a new feature or a changed default that keeps working under `### Added` or `### Changed` (a minor), a fix under `### Fixed` (a patch).
7. **No AI-attribution markers**: per `_core/project-template/.claude/rules/git.md`, never `Co-Authored-By: Claude`, never "Generated with Claude Code" footers, never claude.com links in PR bodies or commit messages.

## Checklist

Mistakes this repo has made more than once. Each item names a trigger the diff shows: check only the items whose trigger this diff matches, and skip the rest. A failed check is a blocking finding. A finding that comes up in a second PR becomes an item here, with the PRs it came from.

| Trigger in the diff | Check | Source |
|---|---|---|
| A hook or script under `_core/` changes | Every copy of it matches byte for byte (`.claude/hooks/`, `.github/scripts/`, the project template's copy of a global hook), and when this repo's bind writes the file, so `.bindwright/pristine.json` has a key for it, that entry changes in the same commit | #931 |
| A test or script compares a file's text line by line, or replays a saved file | It drops `\r` before comparing, since a Windows checkout turns line endings into CRLF | #382, #938 |
| Rule, README or CHANGELOG text states how many of something there are (checks, counts, rows, tests) | The number matches the code after this diff | #940 |
| A hook gains a path for input it cannot read (an exception, a missing program, a parse that fails) | The path does what the hook's own header says it does with input it cannot read, whether that is to block with what to fix or to let the call through | #350, #740 |

## Bindwright template text

The pre-screen's `bindwright_templates.py` lists the changed files whose text equals what the Bindwright release recorded in `.bindwright/pristine.json` writes for this project, unedited. Their text is reviewed in Bindwright's own repo, so a finding in the content of a listed file does not count toward this verdict: put it under a heading of its own, "Upstream: Bindwright template text", with the file and line, and the author reports it with `/bindwright:report`. Write each line there as plain text: none opens with 🔴 or the word "Blocking", or puts either right after a short label, since the gate reads such a line as blocking wherever it sits. When every finding is upstream, the verdict is 🟢. How this project's own files fit a listed file (a rule it contradicts, a path or command it names that the repo lacks) is this PR's finding and blocks as usual, and so is anything the PR removes from a listed file by returning it to the template text, such as the project's own hardening of a workflow or hook. A file the check does not list gets the normal review.

## Also escalate when the diff includes

These escalate on their own: the gate's own files in every project (`.github/scripts/**`, `.github/review-gate.yml`, this guide, the review workflows and the project's check folder), and this repo's trigger paths in `.github/review-gate.yml` (`escalate.paths`: `_core/`, `engine/`). Mark these for escalation too:

- Default answer changes in `engine/model.js`
- Changes to what `plugin/skills/setup/SKILL.md` asks or installs
- `_core/project-template/.github/workflows/*.template` (canonical CI)

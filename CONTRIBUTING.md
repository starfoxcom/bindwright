# Contributing

Thanks for considering a contribution. This project is solo-maintained on a best-effort basis — open issues and PRs are read but may not be answered immediately.

## Before opening a PR

- **Open an issue first** for anything bigger than a typo or one-file fix. Five minutes of "is this in scope?" saves both of us an afternoon.
- **Branch from `develop`, not `main`.** This project uses Gitflow. `main` holds tagged releases only; all in-flight work lives on `develop`. Your PR should target `develop` as its base — `gh pr create --base develop`. PRs to `main` are reserved for release / hotfix branches owned by the maintainer.
- **Atomic commits.** One logical change per commit. Format: `<type>(<scope>): <imperative description>` — same convention the templates themselves teach.
- **No AI-attribution markers** in commit messages, PR titles, or PR bodies. No `Co-Authored-By: Claude`, no `Generated with Claude Code` footer, no links to `claude.com`/`claude.ai`/`anthropic.com` in commit metadata. The discipline is the work; the tool is a detail.
- **One bundle's defaults are not another's.** When adjusting toggle defaults, change them in `bundles/<n>/bundle.toggles.md`.

## What review looks like

This project ships templates that downstream users install verbatim into their own repos — a malicious or buggy PR landing on `main` could ship harmful code to every future bind. The review surface is load-bearing, so every PR (yours and mine) goes through:

1. **AI routine review.** A Claude-powered workflow auto-fires on every PR open / synchronize. It posts a binary 🔴 / 🟢 verdict comment. 🔴 blocks merge. No "minor non-blocking" findings — anything worth writing down is blocking.
2. **Auto-deep-review** on high-blast-radius diffs (anything touching `_core/` or `engine/`). A second AI pass from Opus, same binary verdict rule. The routine reviewer applies the `needs-deep-review` label automatically.
3. **Maintainer review + approval.** I read the AI verdict, then the diff itself. External PRs require my approval before merge regardless of AI verdict. The combination is the gate — AI catches the mechanical stuff, I catch the contextual stuff and the supply-chain-risk stuff.

What that means for you as a contributor:
- Make your diff small and obvious. Big speculative PRs get pushed back not because they're bad but because they're unreviewable in the time I can give them.
- If the AI flags something on your PR, address it before pinging me. I'll read the verdict before the diff.
- If you genuinely disagree with a 🔴 verdict, explain why in a PR comment — both for me and so the next reviewer of similar work knows the reasoning.

## What's in scope

- Bug fixes in the bind engine (`engine/`), the plugin (`plugin/`) or the page (`page/`).
- Typos, broken links, factual corrections in any of the `.md` files.
- New toggles that codify a discipline the maintainer has already adopted in their own projects. Speculative discipline additions get pushed back; *receipts*-backed proposals get serious consideration.
- New bundles for genuinely distinct shapes (e.g. "research scientist running their own infra" vs the four shipped bundles). Open an issue first.
- Documentation improvements — especially in `SETUP.md`, which Claude reads verbatim.

## What's out of scope

- Renaming existing bundles or toggles. The naming surface is stable; downstream Setup commands reference them by key.
- Reformatting / restyling the HTML page beyond bug fixes — the design is a deliberate aesthetic commit. Discuss in an issue if you have a strong opinion.
- Adding telemetry / analytics. The page runs entirely in the browser; it stays that way.

## Local development

The page lives in `page/`: plain HTML, CSS and JavaScript modules, no build step. Some notes:

- **Serve it, don't open it from `file://`.** The file preview fetches the template files, which `file://` blocks. Run `python -m http.server 8080` from the repo root and open `http://localhost:8080/page/`.
- **The file preview is the real engine.** `page/files.js` runs `engine/bind.js` on the files in `_core/`, so a template change shows up there as it will in a bind.
- **English text lives in the HTML.** Every other language has a dictionary in `page/i18n/`; after changing English text, add the key to each one and regenerate the translated pages with `node tools/page_languages.mjs`.
- **Tests:** `node --test engine/test/page-*.test.js`.

## Releasing a new version

Maintainer-only. Follows Gitflow:

1. Branch `release/vX.Y.Z` from `develop`.
2. Bump `VERSION` (e.g. `v1.2.0`) — SemVer from v1.0.0 onward.
3. Add a section to `CHANGELOG.md` under `[Unreleased]`, then promote it to a dated entry.
4. Open PR `release/vX.Y.Z → main`. After AI + maintainer review pass: merge with `--merge` (true merge commit).
5. Tag `vX.Y.Z` on the merge commit, push the tag.
6. Open PR `release/vX.Y.Z → develop` (or cherry-pick the merge commit back to `develop`) so `develop` stays ahead of `main`.
7. The Pages workflow rebuilds automatically on push to `main`. Build the release zip with `git archive --format=zip --prefix=claude-code-templates/ --output=../claude-code-templates-vX.Y.Z.zip vX.Y.Z` and attach to a GitHub Release via `gh release create`.

## Code of conduct

Be kind, be specific, assume the other person has a good reason. Mean comments are deleted without notice.

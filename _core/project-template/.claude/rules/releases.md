---
paths:
  - "**/CHANGELOG.md"
  - "**/CHANGES.md"
  - "**/HISTORY.md"
  - "**/VERSION"
  - "**/package.json"
  - "**/pyproject.toml"
  - "**/Cargo.toml"
  - "**/pubspec.yaml"
  - "**/*.csproj"
  - "**/build.gradle*"
  - ".github/workflows/**"
  - ".github/scripts/version_check.py"
---

# Releases

How releases are numbered and tagged, and, where the project keeps release branches, how each release reaches them all. `git.md` holds the rest of the git rules.

## Versioning

Size each release by what its users must do:

- **Major:** they must act, or something they use stops working: a command, option or API removed or renamed with no old name kept, a file or save format that old data cannot load, a raised minimum OS, runtime or tool version.
- **Minor:** new features, or changed defaults that keep everything working.
- **Patch:** fixes only.

When a release tool sets the version and the tag, feed it the way its configuration reads and never bump or tag by hand. Otherwise bump every file that carries the version together, and tag the release commit in the style the existing tags use. With a changelog, each change a user must act on goes under `### Breaking`. A project that does not version its releases skips this section.
<!-- TOGGLE:version_check START -->

`.github/scripts/version_check.py <version>` reads the commits since the last release and refuses a version smaller than they need, or a changelog section that does not match it. Run it before each `git tag <version>`, `gh release create <version>` and `gh pr create` from a `release/<version>` branch; where the guard hooks live in the repo, a hook runs it on those commands by itself. Pick the version and the sections it names; never tag around it.
<!-- TOGGLE:version_check END -->
<!-- TOGGLE:code_host_local:off START -->
<!-- TOGGLE:branching_model_gitflow START -->

## Cascade after every merge into `{{MAIN_BRANCH}}`

GitHub does not copy `{{MAIN_BRANCH}}` back into `{{DEV_BRANCH}}`. After a hotfix or release merges:

```bash
git fetch origin
git checkout -b chore/cascade-<name> origin/{{DEV_BRANCH}}
git merge --no-ff origin/{{MAIN_BRANCH}} -m "chore: cascade <name> into {{DEV_BRANCH}}"
git push -u origin chore/cascade-<name>
gh pr create --base {{DEV_BRANCH}} --title "chore: cascade <name> into {{DEV_BRANCH}}" --body-file <file>
```

The hotfix or release is done only when the cascade PR is merged and its branch deleted.
<!-- TOGGLE:github_no_actions:off START -->

## Workflow file changes

Review workflows triggered by comments or schedules run the copy on the GitHub default branch, and the review app refuses its token to a run whose copy of the review workflow differs from that copy, so its review is never posted.
<!-- TOGGLE:default_branch_is_dev START -->
Because `{{DEV_BRANCH}}` is the default branch, workflow changes are ordinary work PRs into `{{DEV_BRANCH}}`. They reach `{{MAIN_BRANCH}}` with the next release. A hotfix cut while `{{DEV_BRANCH}}` holds unreleased workflow changes will fail that check; release first, then cut the hotfix.
<!-- TOGGLE:default_branch_is_dev END -->
<!-- TOGGLE:default_branch_is_dev:off START -->
Because `{{MAIN_BRANCH}}` is the default branch, a change to `.github/workflows/` lands on `{{MAIN_BRANCH}}` first as a `hotfix/<name>` PR, then cascades to `{{DEV_BRANCH}}`. A workflow change made on a feature branch fails the review check.
<!-- TOGGLE:default_branch_is_dev:off END -->
<!-- TOGGLE:github_no_actions:off END -->
<!-- TOGGLE:branching_model_gitflow END -->
<!-- TOGGLE:code_host_local:off END -->

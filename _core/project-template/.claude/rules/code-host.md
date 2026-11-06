# Code host

<!-- TOGGLE:code_host_other START -->
This project's code lives on a host other than GitHub (GitLab, Bitbucket, Gitea, Forgejo, Azure DevOps or another). Bindwright supports only GitHub so far, so this setup is the part that works anywhere, and the GitHub-only parts below are unsupported: adapt them here, and say so when a step has no match on this host.

## First session

1. Ask which host the code lives on, unless `git remote get-url origin` shows it, and write its name on the line below.
2. Check that the host's command-line tool is installed and signed in. When there is none, use the host's web page and say which steps that leaves to the user.

Host: (not set yet)

## Reading the other rules here

The other rules and skills name GitHub's tools. Read each one as the same step on this host:

| The rules say | On this host |
|---|---|
| Pull request, PR | The host's own name for it: merge request on GitLab, pull request elsewhere. |
| `gh pr create`, `gh pr list`, `gh pr merge` | The host's command-line tool: `glab mr` on GitLab, `tea pulls` on Gitea and Forgejo, `az repos pr` on Azure DevOps. Bitbucket has no official one: use its web page. |
| `gh pr checks`, `gh run view`, watching CI | The host's pipeline status and logs, with the same tool or on its web page. |
| The GitHub default branch | The host's default branch setting. |
| `CODEOWNERS` | GitLab, Gitea and Forgejo read a `CODEOWNERS` file too; Bitbucket and Azure DevOps set reviewers in their own settings. |
| A `github.com` address, such as the README's clone line | This host's address for the repo. |

## Left out of this setup

These need GitHub, so setup did not write them. Set one up on this host only when the user asks for it:

- **The size check in CI.** `code-size.md` names `.github/workflows/size-check.yml`, which setup did not write. `.github/scripts/size_check.py` runs anywhere: add a step that runs `python .github/scripts/size_check.py` to the host's pipeline, or run it before each push.
- **AI reviews on every PR.** They run as GitHub Actions; no template exists for other hosts yet.
- **Issue and PR templates.** Each host reads its own folder (`.gitlab/` on GitLab, `.gitea/` on Gitea and Forgejo); copy the wording there if the user wants them.
- **The issue board.** The work state lives in `ROADMAP.md` and the hand-off file instead, which need no host.
<!-- TOGGLE:code_host_other END -->
<!-- TOGGLE:github_no_actions START -->
This project's code lives on GitHub, but its organization blocks GitHub apps, GitHub Actions and project boards. So this setup keeps branches, pull requests and issues, and leaves out everything that needs an app, a workflow run or a board. No check runs on GitHub after a push: the checks below run on this computer before it.

## Left out of this setup

- **CI checks.** No workflow runs, so nothing tests a PR after it is pushed. Run the project's tests before every push, and the size check too when the project has one: `python .github/scripts/size_check.py`.
- **AI reviews on every PR.** They run as GitHub Actions with the review app. A PR is reviewed by people, or by a local review the user asks for in the session.
<!-- TOGGLE:tracker:github START -->
- **The project board.** The work state lives in the issues alone, as `tracker.md` describes for a project without a board.
<!-- TOGGLE:tracker:github END -->
<!-- TOGGLE:tracker:file START -->
- **The project board.** The work state lives in `ROADMAP.md` and the hand-off file, which need no host.
<!-- TOGGLE:tracker:file END -->

## When the organization blocks more

- **The GitHub CLI cannot sign in** (the organization blocks its app too): use GitHub's web page for pull requests and issues, and say which steps that leaves to the user. When the issues cannot be read either, run `/bindwright:setup` again and keep the work state in files.
- **The organization allows apps and Actions later:** run `/bindwright:setup` again and answer plain GitHub, which adds the review workflows and the board.
<!-- TOGGLE:github_no_actions END -->

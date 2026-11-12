# Local review

No CI runs an AI review in this project, so the session reviews each change itself before it merges: two fresh reviewers, the bar and verdict rule the CI reviews use, and nothing about the review leaves this computer.

## When

Before opening a pull request, and again on every new commit before it merges.

## The two reviewers

Save the change first: `git diff <base>...HEAD` to a file in the session's scratchpad, and note the head commit (`git rev-parse HEAD`). Then start two fresh subagents, never forks of this session, so neither shares what the author assumed. Give each:

- the diff file, the head commit and the base branch;
- the folder of this project's rules, `.claude/rules/`, which says what a finding is (code size, clean code, testing, security, dead code);
- the bar and the verdict rule below, written into the brief before the first round;
- that it reads and reports only: it posts, comments, labels, commits and pushes nothing, on GitHub or anywhere else, and returns its verdict to the session;
- that a long test run may move to the background, and the verdict waits for its result.

The **routine reviewer** reads the whole diff for correctness and for breaches of the project's rules, and runs the project's tests and its size check when it has one.

The **deep reviewer** reviews the whole diff adversarially: how it breaks on edge cases, under concurrency, at trust boundaries (user input, files, the network) and in what it removes. The session may add focus points, but never narrows that scope.

## The bar

A finding blocks only when this change causes it: a regression from the base branch, or a break of what the change says it does. A gap the base branch already has is not this change's finding; it becomes a follow-up item in the tracker instead.

## The verdict

Each reviewer ends with one line: `🟢 LGTM` only when the review is fully clean, with no caveats and no nits; otherwise `🔴 Blocking`, after its findings, each with the file and line. "LGTM with caveats" is 🔴. Style preferences are dropped, not listed.

## After a 🔴

Sort each finding against the bar before touching code. Fix what passes it, plus every other copy of the same mistake, with the smallest change and no new features, commit, and run both reviewers again on the new head. After 3 red rounds in a row, look up how others solved the same problem and simplify the design, then continue; again at every 3rd red round.

## Merging

Merge only when both reviewers gave 🟢 on the exact head commit, with the merge style `git.md` names and `--match-head-commit <sha>`, so the merge fails if the branch moved. When the GitHub CLI cannot sign in, the user merges on GitHub's page after checking that the pull request's last commit is still that one. Any new commit runs both reviewers again.

## Nothing leaves this computer

The verdicts stay in this chat. Never post them, or any sign of the review, to GitHub or any other site: no pull request comment or review, no label, no commit status or check, and no line about it in a pull request body or a commit message. A verdict on the pull request would show that an AI reviewed the code before anyone else read it.

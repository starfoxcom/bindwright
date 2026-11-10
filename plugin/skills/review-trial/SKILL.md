---
name: review-trial
description: Compare models for this repo's AI review on its own merged pull requests, within what the user's plan includes. Builds the cases from past reviews, shows the cost before anything runs, and recommends whether to change the review settings.
---

# /bindwright:review-trial

The review gate runs one model at one effort for each review tier, set in `.github/review-gate.yml`. This skill tests other choices on the repo's own history: each candidate reviews the same past pull requests blind, judges score every review against what is known about those pull requests, and the result says which choice catches the most real problems for the least usage. Nothing changes in the repo unless the user says yes at the end.

## 1. Check the repo

- Find the repo root with `git rev-parse --show-toplevel`. Outside a git repo, say the trial needs one, and stop.
- It needs the CI reviews' history: `.github/review-gate.yml` and merged pull requests that the review gate commented on. Without the file, say the trial compares the CI review tiers this repo does not run (a local review has no saved history to replay), and stop.
- Find the helper as setup's step 0 does (`${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`), installing it on a yes when it is missing or holds another version than the plugin.
- Run `git fetch origin`, so the commits the old reviews read are on this computer.

## 2. Ask what to compare

Ask, one question at a time:

1. **The plan the trial runs on:** Pro, Max, Ultra, or API credits. Every review and judge in the trial runs as a session of this computer's Claude Code, so it counts against that plan's usage limits. On Pro, Fable models run only on paid usage credits, outside the plan's limits; on Max and Ultra they are included. When unsure, the user's usage page in the Claude settings shows the plan.
2. **The tier:** routine (the review every pull request gets; the default) or deep.
3. **The candidates:** read the tier's current `model` and `effort` from `.github/review-gate.yml`; that is always one arm, so the trial compares against what runs today. Suggest one or two others the plan includes (for example the same model at another effort, or another family), at most four arms in all. A Fable arm on Pro goes in only after the user agrees to pay for it in credits.
4. **The size:** light (the default: 4 pull requests, one round, one judge) or full (5 or more pull requests, best of three rounds, two judges, the method behind Bindwright's own pins). Full costs about four times as much as light.

## 3. Build the cases

Run `node "<helper>/hooks/review-trial-states.mjs" <repo root> --tier <tier> --count <4, or the count for full>`. It prints one line of JSON, `{"states": [...], "skipped": [...]}`, with `error` when it found nothing to use. Each state is one past pull request at the commit a review read: a 🔴 review that a later commit fixed (its findings are the known answer) or a pull request whose only review was 🟢 (the clean one, which shows which candidate blocks for nothing).

- Show the user the list in plain words: each pull request's number and title, and whether it had known findings or was clean.
- On `error`, or fewer than 3 states, say what is missing (most often: too few merged pull requests with a red then green review) and stop.
- A trial with no clean state cannot show a review that blocks for nothing. Say so when it happens, and go on only on a yes.

## 4. Show the cost before anything runs

Call the Workflow tool with `scriptPath: "<helper>/workflows/review-trial.js"` and `args`: `plan` (`pro`, `max`, `ultra` or `api`), `tier`, `preset` (`light` or `full`), `arms` (each `{model, effort}`), `tasks` (the `states` as printed), `allow_credits: true` only when the user agreed in step 2, and `dry_run: true`. The dry run starts no agents; it checks the arms against the plan and returns how many reviews (`reviews`), judge runs (`judge_runs`) and agents in all (`agents`) the real run would start.

Tell the user those numbers, and that each review costs about as much usage as one CI review of that pull request on that model, so a light run with three arms is about a dozen reviews plus four judge runs. On Pro that can be a real part of the week's limit. Ask whether to start it. On a refusal from the dry run (an arm the plan does not include), say why and go back to step 2.

## 5. Run it

On a yes, call the Workflow tool again with the same `args` and no `dry_run`. It runs in the background; say so, and that the session is told when it finishes.

## 6. Report

Read the result's `leaderboard` (best first) and `per_state`, and tell the user in plain words:

- Which candidate won, by how many pull requests and rounds, and against today's setting.
- For each candidate: missed real problems (the worst outcome), findings caught, false blocks and findings the judges ruled wrong, and its usage (`output_tokens`).
- Any candidate whose `reviews_scored` is below `reviews_expected`: say how many reviews are missing (a usage limit or a crash). A round with a missing review or judge has no winner, so a run with many missing says little.
- How firm the result is: with light, one round and one judge per pull request, a narrow win can be chance. Recommend a full run before changing anything when the winner is not today's setting and won by one pull request or less.

When a candidate other than today's setting wins clearly, offer to change that tier's `model` and `effort` in `.github/review-gate.yml`, on its own branch and pull request, as any change to the gate's settings is. Change nothing without a yes. Results stay in this chat; nothing is posted to GitHub.

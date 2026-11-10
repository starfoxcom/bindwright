# How the review models are picked

The CI workflows setup writes run an AI review on every pull request, in two tiers: a routine review on every PR and a deep review when the routine one escalates. Which model and effort level each tier runs is decided by head-to-head trials on saved pull requests, never just because a newer model came out. This page records the method and every trial so far, so you can see why the pins are what they are, and rerun the comparison on your own PRs if you want to.

The trials ran in the maintainer's own private projects, so the projects are described here by kind, not by name.

## Current pins (2026-11-09, confirmed by the Opus 5.5 trial the same day)

| Tier | Model | Effort | Backup when it fails |
|---|---|---|---|
| Routine | Fable 5.2 | low | Opus 5.5 at high |
| Deep | Fable 5.2 | medium | Opus 5.5 at high (after one Fable retry) |

They live in `.github/review-gate.yml` in a set-up project, so you can change them there.

## Method

1. **Saved PR states.** Real pull requests from a large private game project, frozen at commits where the right verdict is known and the defects are listed: three clean states and three with known defects for the routine tier, two clean and four with defects for the deep tier.
2. **The current pick runs in the same trial.** Every candidate model and effort, plus the current pin, reviews the same states with the same prompt, word for word, in one run. A candidate is never compared against an older run's numbers.
3. **Best of three.** Each arm reviews each state three times, because one round cannot tell a habit from bad luck.
4. **Two blind judges from two model families** (Fable 5.1 and Opus 5.5, both at high effort) score every review of a state under shuffled ids. A round counts only when both judges pick the same arm, and an arm wins a state with two of three rounds.
5. **A fixed ranking per review,** worst first: a missed real defect, then the wrong verdict, then fewer of the known findings caught, then a false block of a clean PR, then false positives.
6. **Full cost.** Every token kind (input, cache writes, cache reads, output) is priced at the list rates and summed per arm. Cache reads and writes are most of a review's bill, so output tokens alone mislead.
7. **The win rule comes before the results.** A candidate replaces the current pin when it ranks above it and costs the same or less. The maintainer can still choose otherwise, and the reason is written down with the result.

This is the same way Anthropic's [model guide](https://claude.dev/blog/which-claude-model-should-you-build-with/) says to pick a model: real tasks with a known outcome, each candidate at two or three effort levels, and cost per task from the usage numbers. A general guide can't stand in for the trial, though. That guide puts repeated review work on Sonnet 5.5 at medium effort, and on this rubric Sonnet 5.5 at low and medium let every routine state with a defect through (2026-10-04 below).

Two scoring lessons from the trials:

- **Compare in pairs.** With three or more arms in one leaderboard, a round goes only to a single best arm, so two similar candidates that both beat the current pin take rounds from each other. Each candidate is scored against the current pin on its own, from the same judge scores.
- **Tool calls don't break ties.** Fewer tool calls was once the last tie-breaker, as a stand-in for cost. Once cost is priced in dollars, it counts cost twice, and about half the rounds were then decided by a gap of one or two calls. Those rounds now count as ties.

## Trials

### 2026-11-09: Opus 5.5 high against the Fable 5.2 pins

The workflows run Opus 5.5 only at high effort, as the backup on both tiers, so this trial asked whether that setting beats the new Fable 5.2 pins. Same states, rounds and judges as the trial below; 180 review and judge agents across three runs.

| Tier | Arm | Missed defects | False blocks | False positives | Cost | Against the pin |
|---|---|---|---|---|---|---|
| Routine | Fable 5.2 low (pin) | 3 of 9 | 3 of 9 | 3 | $24.96 | |
| Routine | Opus 5.5 high | 3 of 9 | 5 of 9 | 6.5 | $17.58 | loses, 0-1 states, 30% cheaper |
| Deep | Fable 5.2 medium (pin) | 2 of 12 | 3 of 6 | 15 | $38.99 | |
| Deep | Opus 5.5 high | 1 of 12 | 4 of 6 | 19.5 | $26.76 | loses, 0-1 states, 31% cheaper |

Opus 5.5 high costs half as much per token, but it read about twice the cache of the pins, and cache reads cost the same on both models, so it saved about 30% rather than half. It lost both tiers on false blocks of clean PRs and on false positives; on the deep tier it also caught fewer of the known findings (7 against 9), though it missed one real defect fewer. Pins unchanged, and Opus 5.5 high stays the backup.

The same runs also held Opus 5.5 at low and medium, settings the workflows don't use. On the routine tier both lost to the pin, and Opus 5.5 low wrote very short reviews that caught none of the known findings. On the deep tier Opus 5.5 medium came out ahead of the pin (1-1 states, 5-3 rounds) at half its cost, which makes it the candidate to test first if the deep tier's setting is ever reopened.

### 2026-11-09: Fable 5.2

Arms: Fable 5.1 low (the pin), Fable 5.2 low, Fable 5.2 medium. 132 review and judge agents.

| Tier | Arm | Missed defects | False blocks | False positives | Cost | Against the pin |
|---|---|---|---|---|---|---|
| Routine | Fable 5.1 low | 5 of 9 | 2 of 9 | 4.5 | $33.33 | |
| Routine | Fable 5.2 low | 3 of 9 | 2 of 9 | 7 | $25.03 | wins, 2-1 states, 25% cheaper |
| Routine | Fable 5.2 medium | 2 of 9 | 2 of 9 | 7.5 | $25.63 | wins, 2-1 states, 23% cheaper |
| Deep | Fable 5.1 low | 4 of 12 | 4 of 6 | 3.5 | $40.63 | |
| Deep | Fable 5.2 low | 4 of 12 | 3 of 6 | 15.5 | $32.32 | loses, 1-3 states, 20% cheaper |
| Deep | Fable 5.2 medium | 2 of 12 | 3 of 6 | 17 | $39.83 | loses, 1-2 states, 2% cheaper |

False positives are averaged over both judges.

Both Fable 5.2 arms missed fewer real defects and cost less on both tiers. Their weak spot is false positives: on the deep tier they raised four to five times as many as Fable 5.1 low, and the ranking counts those against them, which is why both lose the deep tier as scored.

The pick: Fable 5.2 low for the routine tier, the cheapest arm that won it. Fable 5.2 medium for the deep tier against the ranking, because it missed half as many real defects (2 of 12 against 4), and a missed defect merges while a false positive costs the PR's author a minute to answer. The margins are thin at three rounds and six states: every verdict except routine Fable 5.2 low flips if tool calls break ties.

### 2026-10-04: Sonnet 5.5 and Opus 5.5 at three efforts each

Seven arms against Fable 5.1 low. No Sonnet 5.5 setting earned a seat: at low and medium effort it passed every routine state that had a defect (9 of 9 missed). Opus 5.5 at medium and high missed fewer defects than Fable 5.1 low but raised more than twice the false positives. Pins unchanged.

### 2026-09-22 and 09-23: Opus 5.5, then best of three

A one-round trial first moved the routine tier to Opus 5.5 medium. The same trial rerun as best of three reversed it: Fable 5.1 low won the deep tier 4 states to 1 and the routine tier 3 to 1, because Opus 5.5 medium false-blocked clean PRs in five of its six clean deep reviews and five of its nine clean routine ones. Both tiers moved to Fable 5.1 low, with an Opus backup. A second project ran the same harness on its own PRs and agreed on both tiers. This trial is why every trial since is best of three.

### 2026-09-02: after Fable 5.1 came out

The deep tier moved from Opus 4.8 to Fable 5.1 low, the arm that found the most confirmed defects at the lowest spend. The routine tier stayed on Sonnet 5.

## Running it yourself

Run `/bindwright:review-trial` in your repo. It builds the cases from your own merged pull requests (a 🔴 review that a later commit fixed gives known findings; a pull request whose only review was 🟢 is the clean one), so it needs the CI reviews' history: a repo with a local review only has none to replay.

It asks your plan first and offers only the models that plan includes. Every review and judge runs as a session of your Claude Code, so the trial counts against your plan's usage limits; on Pro, Fable models bill paid usage credits, so a Fable candidate goes in only after you agree to that. Today's setting is always one of the candidates.

Two sizes:

| Size | Pull requests | Rounds | Judges | Use it for |
|---|---|---|---|---|
| Light (default) | 4 | 1 | 1 | A first look, within a plan's normal week |
| Full | 5 or more | best of three | 2 | The method behind these pins, before changing a setting on a narrow win |

Before anything runs, a dry run shows how many reviews and judge runs the trial will start. Each review costs about as much usage as one CI review of that pull request on that model. Nothing starts without your yes, nothing is posted to GitHub, and the review settings change only on a yes at the end, in a pull request of their own.

The trial is a Claude Code workflow script that ships with Bindwright's helper (`workflows/review-trial.js`), next to the script that builds the cases (`hooks/review-trial-states.mjs`).

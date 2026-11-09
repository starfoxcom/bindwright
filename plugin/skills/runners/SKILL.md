---
name: runners
description: Set up local CI runners for this repo. Checks the computer and the repo's CI, recommends how many runners (or none), installs the ones the user picks and lists them in the runners mod.
---

# /bindwright:runners

A local runner is a program on the user's computer that takes GitHub Actions jobs for this repo, so those jobs stop waiting for GitHub's hosted machines and stop spending its Actions minutes. This skill works out whether that is worth it here and how many fit, then sets up the ones the user picks. Show every command before it runs, and run it only on a yes; a command that needs `sudo` or an administrator prompt is one the user runs themselves (in the CLI, `! <command>`).

## 1. Check the repo

- Find the repo root with `git rev-parse --show-toplevel`. Outside a git repo, say runners belong to a GitHub repo, and stop.
- `gh repo view --json nameWithOwner,visibility,viewerPermission`. Without `gh`, signed out, or with no GitHub remote, say what is missing and stop. Registering a runner needs `ADMIN` permission; with less, say so and stop.
- **A public repo:** say plainly that anyone can open a pull request on it, and a workflow that runs on pull requests would run their code on this computer. GitHub advises self-hosted runners for private repos only. Go on only when the user says yes after hearing that, and then point only workflows that never run on pull requests from forks at the runners.

## 2. Assess

Find the helper as setup's step 0 does (`${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md`), installing it on a yes when it is missing or holds another version than the plugin. Run `node "<helper>/hooks/runners-assess.mjs" <repo root>`. It prints one line of JSON: the computer (`hardware`), whether the `shared-pc` and `runners` mods are installed, the repo's CI (`ci`: workflow files, jobs, jobs already on self-hosted runners, and from the jobs of the 20 newest runs, how many it `sampled`, their median wait for a runner and the most that ran at once), how many runners fit (`limit`) and a `recommendation`. Each runner is budgeted 2 cores, 4 GB of RAM and 20 GB of disk, after keeping 2 cores and 4 GB for the user, or 4 cores and 8 GB when `shared-pc` is installed, since then the computer also runs heavy work of its own.

Tell the user, in two or three plain lines: their computer (cores, RAM, free disk), how many runners fit, and what their CI does now (how many jobs, how long they wait for a runner, how many run at once). When the median wait is under a minute, say so plainly: GitHub's machines already start fast for this repo, so local runners would mostly save Actions minutes and run on the user's own hardware, not cut waiting.

## 3. Recommend, as one question

Ask with the question tool, recommended option first:

- **`kind: "count"`:** offer `count` runners, marked recommended, with the reason in one line: when `limitedBy` is `"load"`, the recent runs never had more than that many jobs going at once; when it is `"hardware"`, the computer fits `count` while the CI could use `wanted`. Also offer one fewer (when `count` is above 1) and "None".
- **`kind: "options"`** (the repo has no CI jobs yet): one option per entry, each with what it would run (`runs`), the last being "Do nothing". Say these runners take jobs only once the repo has workflows that ask for them, and offer to write a first workflow for what the option runs, as a separate yes.
- **`kind: "none"`:** the computer has no room for a runner beside the user's own work. Say so and go to step 4 without asking.

A runner only takes jobs whose `runs-on` names its labels. Say which jobs would move (those running on `ubuntu-latest` today, when the runners will be Linux), and that the change is one line per job, plus `runner:` in `.github/review-gate.yml` for the AI review jobs. Offer those edits after the install, as a diff the user approves file by file.

## 4. Do nothing

When the user picks none, or nothing needs a runner: if `runnersMod` is true, suggest turning the `runners` mod off, since it adds its row and instructions to every session for nothing, which leaves that context for the work. Turning it off is `/bindwright:setup global` with a no for `runners`, or removing `~/.claude/mods/runners` from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`; it applies from the next session. Then stop.

## 5. Install

For each runner the user picked, in order:

1. **Where it runs.** On Windows, a Linux runner inside WSL fits the usual `ubuntu-latest` jobs; a Windows runner fits only Windows jobs. On macOS and Linux it runs natively. Ask when the repo's jobs need both.
2. **An account of its own,** with no Claude Code setup in it (no `~/.claude`): the AI review jobs load the user settings, hooks and instructions of the account they run under. The review jobs install the CLI with npm; without a Linux Node 22 or newer on the account they download the official Node build for the job, checked against a pinned checksum, so the runner needs no Node install. On Linux and in WSL, `sudo useradd -m -s /bin/bash gh-runner`; on Windows, a local standard user. Reuse the account for every runner.
3. **The runner program.** Read the newest release with `gh api repos/actions/runner/releases/latest`, take the asset for the system and processor (`actions-runner-linux-x64-<version>.tar.gz`, `-win-x64-`, `-osx-arm64-` …), and check its SHA-256 against the hash the release notes list for it before unpacking. A mismatch stops the install. Unpack into a folder of its own per runner, owned by the runner account: `/opt/actions-runner-<n>` or `C:\actions-runner-<n>`.
4. **Register it.** Get a registration token with `gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token`. It works for one hour and is a secret: pass it straight into the next command through a variable, never print it, and never write it to a file or the chat. Then, as the runner account, `./config.sh --unattended --url https://github.com/<owner>/<repo> --token "$TOKEN" --name <computer>-<n> --labels self-hosted,<linux|windows|macos>,bindwright --work _work` (`config.cmd` on Windows).
5. **Start it as a service,** so it survives a restart: `sudo ./svc.sh install gh-runner` then `sudo ./svc.sh start` on Linux (inside WSL this needs `systemd=true` under `[boot]` in `/etc/wsl.conf`); on Windows, answer yes to the service question `config.cmd` asks, or pass `--runasservice`.
6. **Check it is online:** `gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | "\(.name): \(.status)"'` shows it `online` within a minute. If it stays `offline`, show the newest file in the runner's `_diag` folder.

Then list the runners in the `runners` mod, one set for the runners of this repo: `/runners add <name> <program> <owner>/<repo>`. The program is `Runner.Listener` for a runner that runs natively, and `vmmemWSL` for runners inside WSL on Windows, since Windows sees the WSL machine, not the runner in it; a set with both takes `Runner.Listener,vmmemWSL`. For runners inside WSL, also add a `wsl` field to the set in `~/.claude/mods-data/runners/runners.json`: `{"distro": "<name from wsl -l>", "disk": "<path of its ext4.vhdx>"}`, the path being the distro's `BasePath` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` plus `ext4.vhdx`. The row then shows the disk's size against the data in it, and says when compacting is worth it. When the mod is not installed, offer it: `python "<helper>/engine/home.py" add-mod "<helper>/_core/global-template/mods/runners"`, which takes effect after the CLI restarts. Start and Stop commands go in `~/.claude/mods-data/runners/runners.json` by hand; offer to write them (`sudo ./svc.sh start` and `stop` in each runner's folder, or the Windows service's `Start-Service` and `Stop-Service`).

## 6. Upkeep

- **Logs.** Each runner's `_diag` folder grows by about 50 MB a day and is never cleaned. Offer one step at the start of the first job of the repo's most frequent workflow that runs on these runners, so the cleanup is versioned and reviewed rather than a hidden scheduled task: `find /opt/actions-runner-*/_diag -maxdepth 1 -name '*.log' -mtime +7 -delete` on Linux, or `Get-ChildItem C:\actions-runner-*\_diag -Filter *.log | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item` on Windows. Show it as a diff and write it on a yes.
- **The WSL disk.** WSL's virtual disk grows as files are written and never shrinks by itself. Tell the user these steps once, for when the `runners` row says `compact` (the disk file is 10 GB or more larger than the data `df -h /` shows inside the distro); never run them automatically, since they stop the runners:
  1. Wait until no runner is busy; with the `shared-pc` mod, hold its seat.
  2. Inside the distro, as root: `fstrim -av`, so the freed space can be given back.
  3. `wsl --shutdown`.
  4. In an administrator `diskpart`: `select vdisk file=<path to the distro's ext4.vhdx>`, then `compact vdisk`. No `attach` or `detach`: the disk is not attached.
  5. Start the distro again so its runner services come back. A Windows runner was never stopped, so start only the WSL ones.

## 7. Finish

Tell the user, one line each: the runners now online and their labels, where each lives and under which account, the jobs that moved to them (or that none have yet), the `runners` mod row, and the upkeep step when it was added. Say that `./config.sh remove --token <a removal token>` (`gh api -X POST repos/<owner>/<repo>/actions/runners/remove-token`) takes a runner off the repo, after its service is stopped and uninstalled.

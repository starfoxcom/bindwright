// The machine's local CI runners. It ships empty, so the band stays hidden until you add your own,
// here or, to keep them through template updates, as a JSON array of the same entries in
// ~/.claude/mods-data/runners/runners.json (read at session start, after this list). Each entry:
//   label      what the band calls it
//   processes  process names that all run while the runners are up (tasklist on Windows, pgrep -f
//              elsewhere); "on" means every one of them is running
//   repo       'owner/name' whose runners, queued runs and scheduled workflows are shown (needs `gh`);
//              optional. Schedules are read from the repo's default branch, the one cron runs.
//   start      the command (argv) the Start button runs; optional, no button without it. It must
//              launch the runners and return (a script that starts them in the background, as
//              below): the button waits for it, up to 30 s, and a command still running then is cut off
//   stop       the commands (argv each, run in order) the Stop button runs; optional
//   wsl        optional: the WSL distro the runners live in, and the path of its virtual disk file
//              (ext4.vhdx). The band then shows the disk's size against the data inside it.
//
// Example, a GitHub Actions self-hosted runner on Windows plus Linux runners in WSL:
//   {
//     label: 'runners',
//     processes: ['Runner.Listener', 'vmmemWSL'],
//     repo: 'me/my-game',
//     start: ['wscript.exe', 'C:/Users/me/start-runners.vbs'],
//     stop: [
//       ['wsl', '--shutdown'],
//       ['powershell', '-NoProfile', '-Command', 'Stop-Process -Name Runner.Listener -Force'],
//     ],
//     wsl: { distro: 'Ubuntu', disk: 'C:/Users/me/AppData/Local/wsl/{id}/ext4.vhdx' },
//   },

export type Runner = {
  label: string
  processes: string[]
  repo?: string
  start?: string[]
  stop?: string[][]
  wsl?: { distro: string; disk: string }
}

export const RUNNERS: Runner[] = []

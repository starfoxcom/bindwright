# Global template — merge into `~/.claude/`

These files live OUTSIDE your project repo, in your home Claude config. They apply to **every** Claude Code session on your machine, not just this project.

## Files in this folder

```
global-template/
├── README.md                              # (this file)
├── CLAUDE.md.additions                    # Append to ~/.claude/CLAUDE.md
├── memory-template/
│   └── MEMORY.md                          # Empty index — copy to the per-project memory dir
├── hooks/
│   ├── code-research-first.py.template    # Generic PreToolUse hook (rendered at bind time)
│   ├── code-research-profiles.json        # Per-tool profiles consumed by the renderer
│   ├── push-guard.py                      # PreToolUse hook that blocks ordinary force pushes
│   ├── no-ai-attribution.py               # PreToolUse hook that blocks AI attribution in commits and PRs
│   ├── session-title.py                   # SessionStart and UserPromptSubmit hook that names each session
│   └── time-injection.snippet.md          # Optional UserPromptSubmit hook — injects [time] ... per prompt
└── mods/                                  # Optional function-hook plugins (Claude Code 2.1.287+)
    ├── README.md                          # What each mod does, install, options, tests
    ├── ci-watch/                          # Watches a pushed PR's checks, wakes the session once
    ├── compact-handoff/                   # Compaction as a focused hand-off, plus a recall tool
    ├── session-facts/                     # Time, context fill and plan usage on every prompt
    ├── shared-pc/                         # One session at a time runs heavy work on the machine
    ├── skill-check/                       # Follows up when a skill's run skips a required step
    ├── tasks/                             # Keeps the task list honest and visible
    └── usage-guard/                       # Pauses sessions near a plan limit, resumes after the reset
```

---

## 1. Merge `CLAUDE.md.additions` into `~/.claude/CLAUDE.md`

`~/.claude/CLAUDE.md` is your private global instruction file. Claude Code loads it into every session as system context. If you don't have one yet, just `cp CLAUDE.md.additions ~/.claude/CLAUDE.md`.

If you DO have one, append the contents of `CLAUDE.md.additions` (or have Claude do it during SETUP — it checks for conflicts and asks before overwriting).

The additions include:

- **No-Explore-agents-for-code-research rule** — overrides any skill recommendation to use `Agent(subagent_type=Explore)` for code research when the project's chosen code-research tool (`tools.code_research` — tokensave / none / custom) is available. Hard rule, no exceptions; per-tool guidance lives in the relevant `:code_research:<tool>` blocks within `CLAUDE.md.additions`.
- **Memory system instructions** — the four memory types, when to save each, when to access, how MEMORY.md works as an index.

These are project-agnostic — they're useful for any project, which is why they live in the global config.

---

## 2. Set up the memory system

The per-project memory home is:

```
~/.claude/projects/<project-slug>/memory/
```

where `<project-slug>` is what Claude Code auto-derives from your project's working-directory path (you can find it via `~/.claude/projects/`).

After SETUP determines the slug:

1. Copy `memory-template/MEMORY.md` to `~/.claude/projects/<project-slug>/memory/MEMORY.md` (if it doesn't already exist).
2. The memory types, when to save each and the body structure come from the "Auto memory" section of `CLAUDE.md.additions`, merged into `~/.claude/CLAUDE.md` in step 1.

Claude will start populating memory entries during your normal sessions — you don't need to pre-fill anything beyond the empty MEMORY.md index.

---

## 3. Install the code-research-first hook (optional, recommended)

`hooks/code-research-profiles.json` holds one profile per code-research tool: how to install it, how to wire it into Claude Code, how to index a project, and who redirects `Grep`/`Glob`/`Bash` searches to it. Its keys match the engine's tool list (`engine/model.js`), and a test keeps the two in step.

| Key | Tool | Search redirect |
|---|---|---|
| `tokensave` | tokensave | the tool's own installer adds it (`tokensave install --agent claude`) |
| `none` | (no tool) | none |
| `custom` | a tool you name | this hook, as a stub; detection looks for the tool's CLI on PATH |

This hook is installed only for profiles whose `hook.source` is `bindwright`. It is registered in `~/.claude/settings.json` under `hooks.PreToolUse`, so it intercepts `Grep`/`Glob`/`Bash` calls and routes Claude through the tool first.

**Manual install:** substitute the six placeholders in `hooks/code-research-first.py.template` against your tool's profile, save it, and register it in `~/.claude/settings.json`. **Worked example for a custom tool named `mygraph`** (a made-up name; substitute your own tool, index folder and commands):

1. Read `hooks/code-research-profiles.json` and copy the `custom` entry's `hook` object. Write your own `sequence_bullets` (a multi-line string with embedded `\n`s) for step 3, replacing the stub bullets with your tool's lookup commands. Do not shorten the bullets; the rendered hook prints them on every block.

2. Copy `hooks/code-research-first.py.template` to `~/.claude/hooks/mygraph-first.py` (the profile's `filename_basename` plus `.py`; expand `~` to your real home path — Windows: `C:/Users/<name>/.claude/hooks/...`, POSIX: `/home/<name>/.claude/hooks/...`).

3. Substitute these SIX placeholders (every occurrence; case-sensitive):
   - `{{TOOLS_CODE_RESEARCH_NAME}}` → `MyGraph` (the DISPLAY_NAME line wraps it as `"MyGraph"` — Python string literal)
   - `{{TOOLS_CODE_RESEARCH_NAME_KEBAB}}` → `mygraph`
   - `{{TOOLS_CODE_RESEARCH_BYPASS_MARKER}}` → `RESEARCH_BYPASS:`
   - `{{TOOLS_CODE_RESEARCH_DETECTION_MODE}}` → `walk_up`
   - `{{TOOLS_CODE_RESEARCH_DETECTION_TARGET}}` → `.mygraph/mygraph.db`
   - `{{TOOLS_CODE_RESEARCH_SEQUENCE_BULLETS}}` → your bullets from step 1 (the JSON-decoded form — `\n` characters become actual newlines inside the rendered `SEQUENCE_BULLETS = """..."""` triple-quoted block)

   The name and bypass marker come from the engine (`engine/model.js`), which uses `RESEARCH_BYPASS:` for every tool without a marker of its own.

4. Verify the substituted file is valid Python. Use the rendered absolute path (not `~`, which `open()` does not expand):
   - macOS/Linux: `python3 -c "import ast, os; ast.parse(open(os.path.expanduser('~/.claude/hooks/mygraph-first.py')).read())"`
   - Windows: `py -c "import ast, os; ast.parse(open(os.path.expanduser('~/.claude/hooks/mygraph-first.py')).read())"`
   - If the file parses successfully, the command exits silently. A `SyntaxError` means a placeholder substitution failed; re-check step 3.

5. Add this entry to `~/.claude/settings.json` under `hooks.PreToolUse[]`. **If the array already has entries, APPEND yours; do NOT replace the array** (you'll wipe out memory + other hooks).

   The new entry you're appending is just the inner object:

   ```json
   {
     "matcher": "Grep|Glob|Bash",
     "hooks": [
       { "type": "command", "command": "py \"C:/Users/<name>/.claude/hooks/mygraph-first.py\"" }
     ]
   }
   ```

   The full file should look like this AFTER your edit (illustrative — your file probably has more entries):

   ```json
   {
     "hooks": {
       "PreToolUse": [
         { "matcher": "...", "hooks": [{ "type": "command", "command": "your existing entries stay here, unchanged" }] },
         {
           "matcher": "Grep|Glob|Bash",
           "hooks": [
             { "type": "command", "command": "py \"C:/Users/<name>/.claude/hooks/mygraph-first.py\"" }
           ]
         }
       ]
     }
   }
   ```

   (No JSON comments — JSON doesn't support them. If you need a marker in your file, use a dummy key like `"_note": "..."`.)

   - Replace `py` with `python3` on macOS/Linux.
   - Replace `<name>` with your username (Windows) or expand to your full home path (POSIX) — Claude Code does NOT auto-expand `~` in hook command strings.
   - Trailing commas in JSON are invalid — re-check after editing.

6. Reload Claude Code (`/exit` + reopen). Test by running a `Grep` in a directory with `.mygraph/` — the hook should block.

**For a custom tool**, use the `custom` profile with your tool's name, kebab name and homepage in place of its `{{TOOLS_CODE_RESEARCH_*}}` placeholders, then replace the stub bullets in the rendered hook with the tool's own commands. The substitution list is identical.

**⚠️ Advisory enforcement, not a security boundary** — the hook fails open on malformed input and unknown profile fields. Treat it as a Claude-discipline nudge, not as a sandbox.

**Why globally not project-local:** project-local hooks can trigger tool-specific template-inheritance bugs that corrupt `settings.local.json` on every Stop event. The global install sidesteps that. Re-binding a project with a different `tools.code_research` value replaces the registered hook + deletes the orphan file after confirmation.

---

## 4. Install the time-injection hook (optional, recommended)

Claude Code has no built-in time-of-day awareness across turns — every prompt looks the same to the model regardless of whether ten minutes or ten hours passed since the last one. The `UserPromptSubmit` hook documented in `hooks/time-injection.snippet.md` fixes this by prepending a `[time] YYYY-MM-DD HH:MM:SS <zone>` line to every prompt (zone resolved from the OS at call time — IANA via the Node command, OS-localized abbreviation via the Python fallback; see the snippet file for the trade-off).

It's project-agnostic, parameter-free (the zone comes from the OS at call time — no per-project bind substitution), costs ~50 ms per prompt, and has no side effects. Recommended for any non-trivial project; load-bearing for multi-day sessions, polling loops, and any reasoning that depends on wall-clock truth.

To install, follow the worked example in `hooks/time-injection.snippet.md` — it documents the Node command (with a Python fallback), the JSON entry to append to `~/.claude/settings.json` under `hooks.UserPromptSubmit`, and the verification step. The hook composes cleanly with the code-research-first hook from § 3; they register under different slots and never conflict.

The AI-side counterpart — instructions that tell the model to attend to the `[time]` lines rather than ignore them — lives in `CLAUDE.md.additions` under the "Time-of-day awareness" section, so step 1 above already covered it.

---

## 4b. Install the push guard (recommended)

The project's deny rules match command text, so a force push written as a bundle of short flags (`git push -qf`) gets past them. `hooks/push-guard.py` reads the command's text with quoting removed and blocks a `git push` carrying `--force`, `-f` inside any flag bundle, `--mirror` or a `+` refspec, wherever it appears in the command. `--force-with-lease` and `--force-if-includes` stay allowed. It only ever blocks or stays silent, never asks. Text that only mentions a force push (a commit message, a script) is blocked too, as, rarely, is a plain push chained after a quoted string that spans lines or in a Bash command with a `\` ending a line when a force word follows it anywhere, and the message says to pass such text in a file, or to put such a command on one line or run the push as its own command. It is a safety net for force pushes written the ordinary way, not a sandbox; its docstring lists what stays out of reach.

`/bindwright:setup` installs it to `~/.claude/hooks/push-guard.py`, registers it in `~/.claude/settings.json` by the absolute path of a Python 3.8+ interpreter found on the machine (`engine/home.py install-hook`, whose launcher keeps a missing file from blocking every command), and then asks whether pushes should run without a prompt in every project. Without Python, or if you say no, pushes other than a bare `git push` ask for approval.

## 4b2. Install session titles (recommended)

`hooks/session-title.py` names every session on the computer after its project, then `<Project> - <purpose>` once the session's focus is clear, so several open sessions, the phone and the desktop app's session lists tell projects and tasks apart. The project name is the one setup saved in `.bindwright/project.json`, else the name of the repo's folder, else the session's folder, so it works in every project, set up or not. At the start of each session it names the purpose file, `~/.bindwright/session-titles/<session id>.purpose`, and asks the assistant to write the session's focus there in 10 words or fewer; `/session-start` writes it once the plan is approved. Its files live in that folder only, never in a project. The folder sits outside `~/.claude` because the CLI asks before every write inside a `.claude` folder, whatever the allow rules say; setup adds the rule `Edit(~/.bindwright/session-titles/**)` so the purpose is written without a prompt. A title is set once per change, so a name picked with `/rename` stays until the purpose changes.

`/bindwright:setup` installs it to `~/.claude/hooks/session-title.py` and registers it for `SessionStart` and `UserPromptSubmit` (`engine/home.py install-hook --events`).

## 4c. Install the attribution guard (hook location "home")

`hooks/no-ai-attribution.py` denies a git or gh write whose text, or a message file it names, carries AI attribution: an AI co-author trailer, a "generated with" line, a session link or the robot emoji. Plain mentions of a tool pass. `/bindwright:setup` installs it next to the push guard and turns off the harness's own trailers in `~/.claude/settings.json`.

By default a bind ships both guards inside the project instead (`.claude/hooks/`, registered in the committed `.claude/settings.json`), so teammates and cloud sessions get them too; setup then installs neither here. A project launcher steps aside for a guard registered here, so a guard never runs twice.

## 4d. Mods (optional, Claude Code 2.1.287+)

`mods/` holds ten function-hook plugins that run inside Claude Code: session facts on every prompt, a session row (model, project, branch), a compaction hand-off, a local CI watcher, an in-process guard, a shared-machine work queue, skill step checks, task-list upkeep, a plan-usage pause and a local CI runner row. Each is optional; every mod but `runners` and `shared-pc` is recommended for everyone, and `session-facts` supersedes the time-injection hook from § 4. They install globally through `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` and keep their data under `~/.claude/mods-data/<mod>/`. Four of them draw rows above the prompt that take the place of a status line, in the terminal and in the Desktop app (see `mods/README.md`).

See [`mods/README.md`](mods/README.md) for what each mod does, its default and options, how to install, test and validate it, and notes for writing your own.

---

## 5. Verify

After merging, start a fresh Claude Code session in any project and ask:

> "What's the no-Explore-agents-for-code-research rule, and where is per-project memory stored?"

Claude should answer from the global `~/.claude/CLAUDE.md`, not by reading files. If it answers correctly, the global setup is good.

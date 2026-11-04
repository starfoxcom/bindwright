# Security

Bindwright writes files that run on other people's machines and in their CI: guard hooks, review workflows, mods and the setup engine. A flaw in any of them reaches every project set up with it, so reports are welcome and taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for it.

Include what is affected (a template path, the engine, the plugin or a mod), how to reproduce it, and what an attacker could do with it. You should get a first answer within seven days.

## In scope

- Anything under `_core/` that a bind ships: hooks, workflows, rules and skills.
- The bind engine (`engine/`) and the plugin (`plugin/`), including what they write to `~/.claude`.
- The mods under `_core/global-template/mods/`.
- The review gate's scripts and workflows (`.github/`).

## Out of scope

- The guard hooks are safety nets for commands written the ordinary way, not sandboxes; each hook's docstring lists what stays out of reach. A bypass already listed there is a known limit, not a vulnerability.
- Problems in Claude Code itself go to Anthropic, and problems in a third-party tool the setup offers (such as a code-search tool) go to that tool's maintainers.

## Supported versions

Only the latest release gets fixes. A project set up with an older version gets them by running `/bindwright:update`.

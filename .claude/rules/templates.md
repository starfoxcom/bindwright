---
paths:
  - "_core/project-template/**"
---

# Template text

Everything under `_core/project-template/` lands in every project that binds or updates, and each project keeps its copy for months. So the text has to stay true for all of them.

- Evidence-neutral. No model version, benchmark figure, GitHub issue or plan tier as the reason for a rule: those age, and every project inherits the stale claim. Say the reason in lasting terms ("long sessions lose detail; tune from your own log"), and keep the specific evidence in this repo's own bind under `.claude/` or in the PR.
- A section nests under the toggles it depends on. Before adding a section, check whether it names a file, step or behaviour that a `<!-- TOGGLE:name START -->` block produces. If it does, put it inside that block, since a project that turns the toggle off would otherwise get a section pointing at nothing. "Every bundle turns it on" is no reason: projects tune.
- One ritual, one telling. Where another file sums up a skill's steps (the template `CLAUDE.md`'s Sessions lines, a rule that names a step), the summary keeps the skill's steps and their order, since a project reads both as the contract.

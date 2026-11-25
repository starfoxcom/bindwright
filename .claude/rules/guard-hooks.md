---
paths:
  - "_core/global-template/hooks/*.py"
  - "_core/project-template/.claude/hooks/*.py"
  - "tools/test_guard_*.py"
---

# Guard hooks

The guard hooks read shell commands to refuse or note the risky ones, and they ship to every user. A reader that learns one more spelling per review round never converges: each special case is new surface for the next round to find a way around.

- Read plain commands only. A command is read when every character outside its quotes is on an allow-list the reader fully understands; anything else is left unread, never parsed by a new special case.
- A finding that shows a spelling the reader gets wrong is fixed by counting that spelling as not plain, never by teaching the reader the spelling. Allow-lists, never deny-lists: a list of bad characters always misses one.
- Only bypass routes and messages the reader cannot read are refused. Every other unread command runs, noted where the row is in observe mode.
- A new row ships in observe mode, and its log decides whether it ever refuses.
- After two red rounds on a guard PR, check the next fix against these lines before writing it. When it adds a case instead of narrowing what is read, rebuild the reader from its base branch instead.

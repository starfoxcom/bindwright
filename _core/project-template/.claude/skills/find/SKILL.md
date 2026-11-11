---
name: find
description: Locate code before reading or editing it. Use whenever the user asks "where is X", "what calls Y", "find usages of Z", or whenever you need to find a symbol, function, type or pattern yourself.
---

# /find

The lookup sequence for this project's code-research tool, **{{TOOLS_CODE_RESEARCH_NAME}}** ({{TOOLS_CODE_RESEARCH_URL}}). Follow it in order and stop at the first useful result. Read only the range you found, never the whole file.

<!-- TOGGLE:code_research:findwright START -->
## Sequence

1. `find` with a plain-English question, a name, or both: the files that answer it, best first.
2. `search` with one or more regexes, optional `globs` and `context`: every matching line, with the symbol around it. It covers every file the project tracks, Markdown, config and templates included.
3. `symbols` to look a name up by kind (function, class, heading, key).
4. `outline` with a path: its symbols and line ranges, to read only the part you need.
5. `coverage` when a file seems missing: what the index reads and which files yield no symbol.

The index updates itself on every call. A project format it does not know gets a pattern rule in `.findwright/config.json`.
<!-- TOGGLE:code_research:findwright END -->





<!-- TOGGLE:code_research:custom START -->
## Sequence

1. Look the symbol up by name with {{TOOLS_CODE_RESEARCH_NAME}}.
2. From the symbol it found, list its callers and usages.
3. Read only the range it returned.

The tool's documentation ({{TOOLS_CODE_RESEARCH_URL}}) names the exact commands for each step; replace this list with them.
<!-- TOGGLE:code_research:custom END -->

<!-- TOGGLE:code_research:none START -->
## Sequence

1. `Grep` for the name, scoped with `type` or `glob` to the language.
2. `Glob` for file names.
3. `Read` with `offset` and `limit` for the matched range.
4. For "what calls X", Grep for the name and read each caller's range. There is no call graph without an indexer.
<!-- TOGGLE:code_research:none END -->

<!-- TOGGLE:code_research_first START -->
## Falling back to Grep and Glob

Allowed only when:

- {{TOOLS_CODE_RESEARCH_NAME}} returned nothing usable for two differently worded queries;
- the target is not code (Markdown, config, binaries, ignored files);
- {{TOOLS_CODE_RESEARCH_NAME}} is unavailable for this scope.

Say which condition applies. For a shell `grep` or `rg`, add the comment `# {{TOOLS_CODE_RESEARCH_BYPASS_MARKER}} <reason>` to the command so the close-session count treats it as a deliberate fallback.
<!-- TOGGLE:code_research_first END -->

## Citing

Name the call that found it, in one line:

> Found `parseHeader` via `<call>` at `src/codec/header.ts:42`.

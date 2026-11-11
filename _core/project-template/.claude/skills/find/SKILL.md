---
name: find
description: Locate code before reading or editing it. Use whenever the user asks "where is X", "what calls Y", "find usages of Z", or whenever you need to find a symbol, function, type or pattern yourself.
---

# /find

The lookup sequence for this project's code-research tool, **{{TOOLS_CODE_RESEARCH_NAME}}** ({{TOOLS_CODE_RESEARCH_URL}}). Follow it in order and stop at the first useful result. Read only the range you found, never the whole file.

<!-- TOGGLE:code_research:tokensave START -->
## Sequence

1. `tokensave_search` with the symbol name: matches with file and line.
2. `tokensave_context` with a plain-English question when the name is unknown. Pass `keywords` for synonyms; `include_code: true` returns the source.
3. `tokensave_callers`, `tokensave_callees`, `tokensave_impact` to walk the call graph from a located symbol.
4. `tokensave_files` to find files by path pattern.
5. `tokensave_body` to read one symbol instead of its file.

Run `tokensave sync` after large edits so the graph matches the code. tokensave's hook redirects symbol-shaped Grep and Glob calls to these tools.
<!-- TOGGLE:code_research:tokensave END -->





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

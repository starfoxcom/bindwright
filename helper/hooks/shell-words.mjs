// Reads a shell command the way the shell does and prints each simple command with its words.
//
//   node shell-words.mjs bash|powershell < command
//
// Prints one JSON object: {"error": <the command holds syntax it could not read, or a shape
// the guard refuses as unreadable>, "commands": [[word, ...], ...], "assignments":
// [{"name": ..., "value": <word>}, ...]}, commands and the variables they set in source
// order, nested ones (inside $( ... ) or a pipeline) included. A word is a string, or
// {"dynamic": <source text>} when the shell builds it at run time (a variable, a
// substitution, a glob), so its value cannot be known before it runs. A program word built
// at run time that literal text names gives one command per program it can be.
// The attribution guard reads body files from these words. Exits 1 when the parser fails.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PARSERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "parsers");
const GRAMMARS = { bash: "tree-sitter-bash.wasm", powershell: "tree-sitter-powershell.wasm" };

function dynamic(node) {
  return { dynamic: node.text };
}

// Bash: the literal value of one argument node, or a dynamic marker.
const BASH_SKIP = new Set(["variable_assignment", "file_redirect", "heredoc_redirect", "herestring_redirect"]);
const BASH_RUNTIME = new Set(["simple_expansion", "expansion", "command_substitution",
  "process_substitution", "arithmetic_expansion"]);

function bashWord(node) {
  if (node.type === "word" || node.type === "number") {
    return /[*?[]/.test(node.text) ? dynamic(node) : node.text.replace(/\\(.)/gs, "$1");
  }
  if (node.type === "raw_string") return node.text.slice(1, -1);
  if (node.type === "string") {
    if (node.namedChildren.some((c) => BASH_RUNTIME.has(c.type))) return dynamic(node);
    return node.text.slice(1, -1).replace(/\\([$`"\\\n])/g, "$1");
  }
  if (node.type === "concatenation") {
    const parts = node.namedChildren.map(bashWord);
    return parts.every((p) => typeof p === "string") ? parts.join("") : dynamic(node);
  }
  return dynamic(node);
}

// True when a redirect holds words past its own target (`>& log -F msg`, `2>&- -F msg`,
// `<<EOF --body-file x`). Bash passes those to the command, but the grammar files them
// under the redirect in shapes it does not keep consistent, so such a command is reported
// unreadable rather than read with words missing.
function holdsCommandWords(node) {
  // A redirect inside a heredoc's (`<<EOF 2>/dev/null`) is checked on its own when the walk reaches it.
  if (node.type === "heredoc_redirect") return node.childrenForFieldName("argument").length > 0;
  if (node.type === "herestring_redirect") return node.namedChildren.length > 1;
  if (node.type !== "file_redirect") return false;
  // Parts that touch (`$K/r-$id.json` is several nodes) are one word.
  const parts = node.namedChildren.filter((c) => c.type !== "file_descriptor");
  const targets = parts.filter((c, i) => i === 0 || parts[i - 1].endIndex !== c.startIndex).length;
  const closes = node.children.some((c) => c.type === ">&-" || c.type === "<&-");
  return targets > (closes ? 0 : 1);
}

// A variable the command sets (`A=1 git ...`, `export A=1`), with its value as a word.
function bashAssignment(node) {
  const value = node.childForFieldName("value");
  return { name: node.childForFieldName("name")?.text ?? "", value: value ? bashWord(value) : "" };
}

function bashCommand(node) {
  return node.namedChildren.filter((child) => !BASH_SKIP.has(child.type)).map((child) =>
    child.type === "command_name" ? bashWord(child.namedChildren[0] ?? child) : bashWord(child));
}

// PowerShell: the literal value of one command element, or a dynamic marker.
const PS_SKIP = new Set(["command_argument_sep", "redirection", "file_redirection_operator"]);

function psUnescape(text) {
  return text.replace(/`(.)/gs, "$1");
}

function psWord(node) {
  if (node.type === "generic_token" || node.type === "command_parameter" || node.type === "command_name") {
    return /[*?$]/.test(node.text) ? dynamic(node) : psUnescape(node.text);
  }
  if (node.type === "verbatim_string_characters" || node.type === "verbatim_string_literal") {
    return node.text.slice(1, -1).replace(/''/g, "'");
  }
  if (node.type === "expandable_string_literal") {
    if (node.namedChildren.length) return dynamic(node);
    return psUnescape(node.text.slice(1, -1)).replace(/""/g, '"');
  }
  if (["array_literal_expression", "unary_expression", "string_literal"].includes(node.type)
      && node.namedChildren.length === 1) {
    return psWord(node.namedChildren[0]);
  }
  return dynamic(node);
}

function psCommand(node) {
  const words = [];
  const name = node.namedChildren.find((c) => c.type === "command_name" || c.type === "command_name_expr");
  // `& "C:\path\git.exe"` names the program in a string.
  const named = name?.type === "command_name_expr" && name.namedChildren.length === 1 ? name.namedChildren[0] : name;
  words.push(named ? psWord(named) : dynamic(node));
  const elements = node.namedChildren.find((c) => c.type === "command_elements");
  for (const child of elements?.namedChildren ?? []) {
    if (PS_SKIP.has(child.type)) continue;
    words.push(psWord(child));
  }
  return words;
}

// `$env:A = "1"`: the name as written, and the value when it is a plain word or string.
function psAssignment(node) {
  const [left, , right] = node.namedChildren;
  const literal = /^(["']?)([\w.-]*)\1$/.exec(right?.text ?? "");
  return { name: left?.text ?? "", value: literal ? literal[2] : dynamic(right ?? node) };
}

// The PowerShell grammar fails on a bare word joined to a quoted string that holds a bracket
// (`query='{a}'`), which PowerShell reads as one word. Moving the quote to the word's start
// (`'query={a}'`) reads the same, so a failed parse is tried once more that way.
const PS_JOINED_QUOTE = /(^|[\s;|(])([A-Za-z_][\w.-]*=)(['"])/g;
// The bash grammar fails on a here-doc operator followed by another redirect on its line
// (`<<'EOF' >/dev/null; next`); bash reads the redirects in either order, so a failed parse is
// tried once more with the here-doc operator after them.
const BASH_HEREDOC_FIRST = /(<<-?\s*(['"]?)\w+\2)((?:[ \t]+\d*(?:&>>?|[<>]{1,2}&?)[ \t]*[^\s;|&]+)+)/g;
const BASH_LEADING_REDIRECTS = /^(?:[ \t]+\d*(?:&>>?|[<>]{1,2}&?)[ \t]*[^\s;|&]+)*/;

// The bash grammar also fails on a command that goes on after a here-doc on its line
// (`<<'EOF' >/dev/null; git log`). The words are the same with the rest of that line moved
// below the body, its connector dropped, so a failed parse is tried that way too.
function heredocRestBelow(source) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const at = /<<(-?)\s*(['"]?)(\w+)\2/.exec(lines[i]);
    if (!at) continue;
    const head = at.index + at[0].length;
    const tail = lines[i].slice(head).replace(BASH_LEADING_REDIRECTS, "");
    const rest = tail.replace(/^\s*(?:;|&&|\|\||\|)\s*/, "");
    if (rest === tail || !rest.trim()) continue;
    const end = lines.findIndex((l, k) => k > i && (at[1] ? l.replace(/^\t+/, "") : l) === at[3]);
    if (end < 0) continue;
    lines[i] = lines[i].slice(0, lines[i].length - rest.length).replace(/\s*(?:;|&&|\|\||\|)\s*$/, "");
    lines.splice(end + 1, 0, rest);
  }
  return lines.join("\n");
}

// A program word the shell builds at run time names a program only through literal text, as
// ShellCheck reads command names: the literal tail of a path (`"$S/bin/x.exe"`), or a variable
// every value of which, in this command, is known and set before the use. Such a word yields
// each list of leading words it can expand to; null means it could name any program.
const PROGRAM_NAME = /^[\w.+-][\w .+-]*$/;
const MAX_VARIANTS = 16;
const LITERAL_PARTS = {
  bash: new Set(["command_name", "word", "string", "string_content", "raw_string", "concatenation", "number"]),
  powershell: new Set(["command_name", "command_name_expr", "path_command_name", "generic_token",
    "string_literal", "expandable_string_literal", "verbatim_string_characters", "verbatim_string_literal"]),
};
const PS_WRAPPERS = new Set(["pipeline", "pipeline_chain", "logical_expression", "bitwise_expression",
  "comparison_expression", "additive_expression", "multiplicative_expression", "format_expression",
  "range_expression", "array_literal_expression", "unary_expression"]);
// Where a setting runs on every path to a later command in the same shell: the nodes between
// the two, and the node holding both.
const SETTING_PATH = { bash: new Set(["declaration_command", "list", "compound_statement"]),
  powershell: new Set(["pipeline"]) };
const SEQUENCES = { bash: new Set(["program", "compound_statement", "do_group", "subshell", "list"]),
  powershell: new Set(["program", "statement_list"]) };

const baseName = (text) => text.split(/[\\/]/).pop();
const isInside = (node, outer) => Boolean(outer)
  && node.startIndex >= outer.startIndex && node.endIndex <= outer.endIndex;
const hasOr = (node) => node.type === "list" && node.children.some((c) => c.type === "||");

function unwrap(node) {
  while (node && PS_WRAPPERS.has(node.type) && node.namedChildCount === 1) node = node.namedChildren[0];
  return node;
}

function runTimeParts(node, shell) {
  if (!LITERAL_PARTS[shell].has(node.type)) return [node];
  return node.namedChildren.flatMap((child) => runTimeParts(child, shell));
}

function variableName(part, shell) {
  const bash = /^\$(\w+)$|^\$\{(\w+)\}$/.exec(part.text);
  const ps = /^\$(?:(?:global|script|local|private):)?(\w+)$|^\$\{(\w+)\}$/i.exec(part.text);
  if (shell === "bash") {
    return bash && ["simple_expansion", "expansion"].includes(part.type) ? bash[1] ?? bash[2] : null;
  }
  return ps && part.type === "variable" ? (ps[1] ?? ps[2]).toLowerCase() : null;
}

// Every variable setting in the command, with its value: a literal string, the node the shell
// builds it from, or null when it cannot be read (`+=`, a `foreach`, a `for` with no list).
function collectSettings(root, shell) {
  const settings = [];
  const literal = shell === "bash" ? bashWord : psWord;
  const valueOf = (node) => {
    const word = literal(node);
    return typeof word === "string" ? word : node;
  };
  (function walk(node) {
    if (shell === "bash" && node.type === "variable_assignment") {
      const value = node.childForFieldName("value");
      const appends = node.children.some((c) => c.type === "+=");
      const name = node.childForFieldName("name")?.text;
      settings.push({ name, node, value: appends ? null : value ? valueOf(value) : "" });
    }
    if (shell === "bash" && node.type === "for_statement") {
      const name = node.childForFieldName("variable")?.text;
      const values = node.childrenForFieldName("value");
      for (const value of values.length ? values : [null]) {
        settings.push({ name, node, isLoop: true, value: value && valueOf(value) });
      }
    }
    if (shell === "powershell" && node.type === "assignment_expression") {
      const [left, operator, right] = node.namedChildren;
      const name = /^\$(?:(?:global|script|local|private):)?(\w+)\s*$/i.exec(left?.text ?? "")?.[1]?.toLowerCase();
      settings.push({ name, node, value: operator?.text === "=" && right ? valueOf(unwrap(right)) : null });
    }
    if (shell === "powershell" && node.type === "foreach_statement") {
      const name = /\(\s*\$(\w+)/.exec(node.text)?.[1]?.toLowerCase();
      settings.push({ name, node, value: null });
    }
    for (const child of node.namedChildren) walk(child);
  })(root);
  return settings;
}

// True when the command sets `name` some way it does not report as a setting: `read NAME`,
// `printf -v NAME`, `declare NAME`, PowerShell's `Set-Variable NAME` or `[ref]$NAME`.
function hasHiddenSettings(name, facts) {
  const { shell, source, settings } = facts;
  const flags = shell === "bash" ? "g" : "gi";
  const bare = new RegExp(`(?<![\\w$./\\\\:-])(?<!\\$\\{)${name}(?![\\w./\\\\:-])`, flags);
  const named = new Set(settings.filter((s) => s.name === name && shell === "bash").map((s) => s.node.id));
  const ps = new RegExp(`\\[ref\\]\\s*\\$${name}\\b|\\$${name}\\s*(\\+\\+|--)(?![\\w-])|(\\+\\+|--)\\$${name}\\b`, "i");
  return (source.match(bare) ?? []).length > named.size || (shell === "powershell" && ps.test(source));
}

// True when setting `s` runs before `use` on every path to it, in the same shell.
function setsBefore(s, use, shell) {
  if (s.isLoop) return isInside(use, s.node.childForFieldName("body"));
  if (s.node.startIndex >= use.startIndex) return false;
  let node = s.node.parent;
  while (node && !isInside(use, node)) {
    if (!SETTING_PATH[shell].has(node.type) || hasOr(node)) return false;
    node = node.parent;
  }
  return Boolean(node) && SEQUENCES[shell].has(node.type) && !hasOr(node);
}

// Every value `name` can hold where `use` runs, or null when one of them is unknown.
function valuesAt(name, use, facts) {
  const settings = facts.settings.filter((s) => s.name === name);
  if (!settings.length || settings.some((s) => s.value === null) || hasHiddenSettings(name, facts)) return null;
  return settings.some((s) => setsBefore(s, use, facts.shell)) ? settings.map((s) => s.value) : null;
}

function distinct(variants) {
  if (variants.some((v) => v === null)) return null;
  const unique = [...new Map(variants.flat().map((words) => [JSON.stringify(words), words])).values()];
  return unique.length && unique.length <= MAX_VARIANTS ? unique : null;
}

// The leading words a value gives where it is used: bash splits an unquoted value at spaces.
function valueWords(value, isQuoted, facts, depth) {
  const isWhole = isQuoted || facts.shell === "powershell";
  if (typeof value !== "string") return isWhole ? programsOf(value, facts, depth) : null;
  const words = isWhole ? [value] : value.trim().split(/\s+/);
  return PROGRAM_NAME.test(baseName(words[0])) ? [[baseName(words[0]), ...words.slice(1)]] : null;
}

// PowerShell's `Join-Path <folder> "<child>"` ends in its last argument's file name.
function joinPathPrograms(command, facts, depth) {
  const name = command.namedChildren.find((c) => c.type === "command_name")?.text.toLowerCase();
  const elements = command.namedChildren.find((c) => c.type === "command_elements")?.namedChildren ?? [];
  const last = elements.filter((c) => !["command_argument_sep", "command_parameter"].includes(c.type)).at(-1);
  return name === "join-path" && last ? programsOf(last, facts, depth + 1) : null;
}

function substitutedPrograms(word, parts, names, facts) {
  let texts = [""];
  let at = word.startIndex;
  for (const [i, part] of parts.entries()) {
    const values = valuesAt(names[i], word, facts);
    const unquoted = facts.shell === "bash" && word.type !== "string";
    if (!values || values.some((v) => typeof v !== "string" || (unquoted && /\s/.test(v)))) return null;
    const before = word.text.slice(at - word.startIndex, part.startIndex - word.startIndex);
    texts = texts.flatMap((text) => values.map((value) => text + before + value));
    if (texts.length > MAX_VARIANTS) return null;
    at = part.endIndex;
  }
  const programs = texts.map((text) => baseName((text + word.text.slice(at - word.startIndex)).replace(/["']/g, "")));
  return distinct(programs.map((program) => PROGRAM_NAME.test(program) ? [[program]] : null));
}

// Each list of leading words the program word `word` can expand to, or null.
function programsOf(node, facts, depth = 0) {
  const { shell } = facts;
  const word = unwrap(node);
  if (!word || depth > 3) return null;
  if (shell === "powershell" && word.type === "command") return joinPathPrograms(word, facts, depth);
  const parts = runTimeParts(word, shell);
  if (!parts.length) {
    const literal = (shell === "bash" ? bashWord : psWord)(word);
    return typeof literal === "string" ? valueWords(literal, true, facts, depth) : null;
  }
  const tail = word.text.slice(parts.at(-1).endIndex - word.startIndex).replace(/["']/g, "");
  if (/[\\/]/.test(tail) && PROGRAM_NAME.test(baseName(tail))) return [[baseName(tail)]];
  const names = parts.map((part) => variableName(part, shell));
  if (names.includes(null)) return null;
  if (parts.length > 1 || word.text.replace(/["']/g, "") !== parts[0].text) {
    return substitutedPrograms(word, parts, names, facts);
  }
  const values = valuesAt(names[0], word, facts);
  const isQuoted = word.type === "string";
  return values && distinct(values.map((value) => valueWords(value, isQuoted, facts, depth + 1)));
}

function programWord(command, shell) {
  if (shell === "bash") return command.namedChildren.find((c) => c.type === "command_name")?.namedChildren[0];
  return command.namedChildren.find((c) => c.type === "command_name_expr" || c.type === "command_name");
}

export async function shellWords(shell, command) {
  const { Parser, Language } = await import(pathToFileURL(path.join(PARSERS, "web-tree-sitter.mjs")).href);
  await Parser.init({ locateFile: (name) => path.join(PARSERS, name) });
  const parser = new Parser();
  parser.setLanguage(await Language.load(path.join(PARSERS, GRAMMARS[shell])));
  // PowerShell takes typographic quotes as quotes; the grammar knows only the plain ones.
  const source = shell === "bash" ? command
    : command.replace(/[“”„]/g, '"').replace(/[‘’‚‛]/g, "'");
  let tree = parser.parse(source);
  let parsedText = source;
  const retries = shell === "powershell" ? [source.replace(PS_JOINED_QUOTE, "$1$3$2")]
    : [source.replace(BASH_HEREDOC_FIRST, "$3 $1"), heredocRestBelow(source)];
  for (const retry of retries) {
    if (!tree.rootNode.hasError) break;
    const moved = parser.parse(retry);
    if (!moved.rootNode.hasError) [tree, parsedText] = [moved, retry];
  }
  // The bash grammar takes a backslash before CR LF as a line continuation, but bash ends
  // the command there, so it cannot be trusted on a command holding a CR.
  let unreadable = tree.rootNode.hasError || (shell === "bash" && source.includes("\r"));
  const read = shell === "bash" ? bashCommand : psCommand;
  const commands = [];
  const assignments = [];
  const facts = { shell, source: parsedText, settings: collectSettings(tree.rootNode, shell) };
  (function walk(node) {
    if (shell === "bash" && node.type === "variable_assignment") assignments.push(bashAssignment(node));
    if (shell === "powershell" && node.type === "assignment_expression") assignments.push(psAssignment(node));
    if (shell === "bash" && holdsCommandWords(node)) unreadable = true;
    // A bare `$`, `==` or `=~` argument is an unnamed token the word list would skip.
    if (shell === "bash" && node.type === "command" && node.children.some((c) => !c.isNamed)) unreadable = true;
    if (node.type === "command") {
      const words = read(node);
      // A program built at run time that could be any program, git included, cannot be told
      // apart from its arguments, so the command is unreadable.
      const variants = typeof words[0] === "string" ? [[words[0]]] : programsOf(programWord(node, shell), facts);
      if (variants === null) unreadable = true;
      for (const leading of variants ?? [[words[0]]]) commands.push([...leading, ...words.slice(1)]);
    }
    // An array's words reach a command later, wherever it runs, so it is unreadable. So
    // is PowerShell's `--%`, after which the program splits the raw text by its own rules.
    if (node.type === "array" || node.type === "stop_parsing") unreadable = true;
    for (const c of node.namedChildren) walk(c);
  })(tree.rootNode);
  return { error: unreadable, commands, assignments };
}

// Node gives this module its real path, symlinks resolved, so the path it was started by is
// resolved too before the two are compared.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const shell = process.argv[2];
  if (!GRAMMARS[shell]) {
    console.error("usage: node shell-words.mjs bash|powershell < command");
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await shellWords(shell, readFileSync(0, "utf8"))));
  } catch (error) {
    console.error(`shell-words: ${error.message}`);
    process.exit(1);
  }
}

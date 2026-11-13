// Reads a shell command the way the shell does and prints each simple command with its words.
//
//   node shell-words.mjs bash|powershell < command
//
// Prints one JSON object: {"error": <the command holds syntax it could not read>, "commands":
// [[word, ...], ...], "assignments": [{"name": ..., "value": <word>}, ...]}, the commands and
// the variables they set (`A=1 git`, `export A=1`, PowerShell's `$env:A = 1`) in source
// order, nested ones (inside $( ... ) or a pipeline) included. A word is a string, or
// {"dynamic": <source text>} when the shell builds it at run time (a variable, a
// substitution, a glob), so its value cannot be known before it runs.
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

// A variable the command sets, with its value as a word.
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
  return { name: left?.text.trim() ?? "", value: literal ? literal[2] : dynamic(right ?? node) };
}

// The PowerShell grammar fails on a bare word joined to a quoted string that holds a bracket
// (`query='{a}'`), which PowerShell reads as one word. Moving the quote to the word's start
// (`'query={a}'`) reads the same, so a failed parse is tried once more that way.
const PS_JOINED_QUOTE = /(^|[\s;|(])([A-Za-z_][\w.-]*=)(['"])/g;
// The bash grammar fails on a here-doc operator followed by another redirect on its line
// (`<<'EOF' >/dev/null; next`); bash reads the redirects in either order, so a failed parse is
// tried once more with the here-doc operator after them.
// One redirect after a command word; a quoted target may hold spaces, and `<<` is never one.
const REDIRECT = String.raw`[ \t]+\d*(?:&>>?|>>?&?|<(?!<)&?)[ \t]*(?:"[^"]*"|'[^']*'|[^\s;|&'"])+`;
const BASH_HEREDOC_FIRST = new RegExp(String.raw`(<<-?\s*(['"]?)\w+\2)((?:` + REDIRECT + ")+)", "g");
const BASH_LEADING_REDIRECTS = new RegExp(`^(?:${REDIRECT})*`);

// The bash grammar also fails on a command that goes on after a here-doc on its line
// (`<<'EOF' >/dev/null; git log`). The words are the same with the rest of that line moved
// below the body, its connector dropped, so a failed parse is tried that way too.
function heredocRestBelow(source, operators) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const at = /<<(-?)\s*(['"]?)(\w+)\2/.exec(lines[i]);
    const lineStart = lines.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0);
    if (!at || !operators.has(lineStart + at.index)) continue;
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

export async function shellWords(shell, command) {
  const { Parser, Language } = await import(pathToFileURL(path.join(PARSERS, "web-tree-sitter.mjs")).href);
  await Parser.init({ locateFile: (name) => path.join(PARSERS, name) });
  const parser = new Parser();
  parser.setLanguage(await Language.load(path.join(PARSERS, GRAMMARS[shell])));
  // PowerShell takes typographic quotes as quotes; the grammar knows only the plain ones.
  const source = shell === "bash" ? command
    : command.replace(/[“”„]/g, '"').replace(/[‘’‚‛]/g, "'");
  let tree = parser.parse(source);
  // A bash rewrite applies only at a here-doc operator the first parse found, never at a `<<`
  // in arithmetic, quoted text or a here-doc body.
  const operators = new Set();
  (function find(node) {
    if (node.type === "heredoc_redirect") operators.add(node.startIndex);
    if (node.type === "heredoc_start") operators.add(source.lastIndexOf("<<", node.startIndex));
    for (const child of node.children) find(child);
  })(tree.rootNode);
  const retries = shell === "powershell" ? [source.replace(PS_JOINED_QUOTE, "$1$3$2")]
    : [source.replace(BASH_HEREDOC_FIRST, (all, operator, quote, redirects, at) =>
      operators.has(at) ? `${redirects} ${operator}` : all), heredocRestBelow(source, operators)];
  for (const retry of retries) {
    if (!tree.rootNode.hasError) break;
    const moved = parser.parse(retry);
    if (!moved.rootNode.hasError) tree = moved;
  }
  // The bash grammar takes a backslash before CR LF as a line continuation, but bash ends
  // the command there, so it cannot be trusted on a command holding a CR.
  let unreadable = tree.rootNode.hasError || (shell === "bash" && source.includes("\r"));
  const read = shell === "bash" ? bashCommand : psCommand;
  const commands = [];
  const assignments = [];
  (function walk(node) {
    if (shell === "bash" && node.type === "variable_assignment") assignments.push(bashAssignment(node));
    if (shell === "powershell" && node.type === "assignment_expression") assignments.push(psAssignment(node));
    if (shell === "bash" && holdsCommandWords(node)) unreadable = true;
    // A bare `$`, `==` or `=~` argument is an unnamed token the word list would skip.
    if (shell === "bash" && node.type === "command" && node.children.some((c) => !c.isNamed)) unreadable = true;
    if (node.type === "command") commands.push(read(node));
    // An array's words reach a command later, wherever it runs, so it is unreadable. So is
    // PowerShell's `--%`, after which the program splits the raw text by its own rules.
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

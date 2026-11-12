// Reads a shell command the way the shell does and prints each simple command with its words.
//
//   node shell-words.mjs bash|powershell < command
//
// Prints one JSON object: {"error": <the parse hit syntax it could not read>, "commands":
// [[word, ...], ...], "scoped": [index, ...]}, commands in source order, nested ones (inside
// $( ... ) or a pipeline) included; "scoped" lists the commands bash runs in a child shell
// (a subshell, a substitution, a pipeline or a background job). A word is a string, or
// {"dynamic": <source text>} when the shell builds it at run time (a variable, a
// substitution, a glob), so its value cannot be known before it runs.
// The attribution guard reads body files from these words. Exits 1 when the parser fails.
import { readFileSync } from "node:fs";
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
// Bash runs these in a child shell, so a `cd` inside them leaves the outer folder as it was.
const BASH_CHILD_SHELLS = new Set(["subshell", "command_substitution", "process_substitution", "pipeline"]);

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

// The grammar files words that follow a redirect's target (`>& log -F msg`) under the
// redirect, but the shell passes them to the command as arguments.
function redirectArguments(node) {
  if (node.type === "heredoc_redirect") return node.childrenForFieldName("argument").map(bashWord);
  if (node.type !== "file_redirect") return [];
  return node.namedChildren.filter((c) => c.type !== "file_descriptor").slice(1).map(bashWord);
}

function bashCommand(node) {
  const words = [];
  for (const child of node.namedChildren) {
    if (BASH_SKIP.has(child.type)) {
      words.push(...redirectArguments(child));
      continue;
    }
    words.push(child.type === "command_name" ? bashWord(child.namedChildren[0] ?? child) : bashWord(child));
  }
  const parent = node.parent;
  if (parent?.type === "redirected_statement") {
    for (const sibling of parent.namedChildren) words.push(...redirectArguments(sibling));
  }
  return words;
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
    if (child.type === "stop_parsing") {
      // After --% PowerShell passes the rest of the line to the program verbatim.
      words.push(...child.text.replace(/^--%/, "").split(/\s+/).filter(Boolean));
      continue;
    }
    words.push(psWord(child));
  }
  return words;
}

export async function shellWords(shell, command) {
  const { Parser, Language } = await import(pathToFileURL(path.join(PARSERS, "web-tree-sitter.mjs")).href);
  await Parser.init({ locateFile: (name) => path.join(PARSERS, name) });
  const parser = new Parser();
  parser.setLanguage(await Language.load(path.join(PARSERS, GRAMMARS[shell])));
  // PowerShell takes typographic quotes as quotes; the grammar knows only the plain ones.
  const source = shell === "bash" ? command
    : command.replace(/[“”„]/g, '"').replace(/[‘’‚‛]/g, "'");
  const tree = parser.parse(source);
  // The bash grammar takes a backslash before CR LF as a line continuation, but bash ends
  // the command there, so it cannot be trusted on a command holding a CR.
  const unreadable = tree.rootNode.hasError || (shell === "bash" && source.includes("\r"));
  const read = shell === "bash" ? bashCommand : psCommand;
  const commands = [];
  const scoped = [];
  (function walk(node, inChild) {
    if (node.type === "command") {
      if (inChild || node.nextSibling?.type === "&") scoped.push(commands.length);
      commands.push(read(node));
    }
    const child = inChild || (shell === "bash" && BASH_CHILD_SHELLS.has(node.type));
    for (const c of node.namedChildren) walk(c, child);
  })(tree.rootNode, false);
  return { error: unreadable, commands, scoped };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
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

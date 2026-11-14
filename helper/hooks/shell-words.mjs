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
const SHELLS = new Set(["bash", "powershell"]);

function dynamic(node) {
  return { dynamic: node.text };
}

// Bash is read by mvdan.cc/sh's parser, built to WebAssembly from tools/shell-words-bash, which
// prints the result object itself.
async function bashWords(command) {
  globalThis.crypto ??= (await import("node:crypto")).webcrypto;
  await import(pathToFileURL(path.join(PARSERS, "go-wasm-exec.mjs")).href);
  const go = new globalThis.Go();
  const module = readFileSync(path.join(PARSERS, "shell-words-bash.wasm"));
  const { instance } = await WebAssembly.instantiate(module, go.importObject);
  globalThis.shellWordsInput = command;
  await go.run(instance);
  const result = JSON.parse(globalThis.shellWordsOutput);
  // The parser drops a CR that bash keeps in the word, so a command holding one cannot be trusted.
  if (command.includes("\r")) result.error = true;
  return result;
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

async function powershellWords(command) {
  const { Parser, Language } = await import(pathToFileURL(path.join(PARSERS, "web-tree-sitter.mjs")).href);
  await Parser.init({ locateFile: (name) => path.join(PARSERS, name) });
  const parser = new Parser();
  parser.setLanguage(await Language.load(path.join(PARSERS, "tree-sitter-powershell.wasm")));
  // PowerShell takes typographic quotes as quotes; the grammar knows only the plain ones.
  const source = command.replace(/[“”„]/g, '"').replace(/[‘’‚‛]/g, "'");
  let tree = parser.parse(source);
  if (tree.rootNode.hasError) {
    const moved = parser.parse(source.replace(PS_JOINED_QUOTE, "$1$3$2"));
    if (!moved.rootNode.hasError) tree = moved;
  }
  let unreadable = tree.rootNode.hasError;
  const commands = [];
  const assignments = [];
  (function walk(node) {
    if (node.type === "assignment_expression") assignments.push(psAssignment(node));
    if (node.type === "command") commands.push(psCommand(node));
    // After `--%` the program splits the raw text by its own rules.
    if (node.type === "stop_parsing") unreadable = true;
    for (const c of node.namedChildren) walk(c);
  })(tree.rootNode);
  return { error: unreadable, commands, assignments };
}

export async function shellWords(shell, command) {
  return shell === "bash" ? bashWords(command) : powershellWords(command);
}

// Node gives this module its real path, symlinks resolved, so the path it was started by is
// resolved too before the two are compared.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const shell = process.argv[2];
  if (!SHELLS.has(shell)) {
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

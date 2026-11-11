#!/usr/bin/env node
// findwright: build and query the project index from the shell.
//   findwright refresh
//   findwright search <regex> [<regex> ...] [--glob G] [-i] [-C N] [--all]
//   findwright symbols <name> [--kind K] [--glob G]
//   findwright outline <path>
//   findwright coverage
// Runs from the repo root (or any folder inside it).

import { execFileSync } from "node:child_process";
import { openIndex, readConfig, refresh } from "./store.mjs";
import { coverage, outline, search, symbols } from "./query.mjs";

function parse(argv) {
  const opts = { positional: [], globs: [], ignoreCase: false, context: 0, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--glob") opts.globs.push(argv[++i]);
    else if (arg === "--kind") opts.kind = argv[++i];
    else if (arg === "-i") opts.ignoreCase = true;
    else if (arg === "--all") opts.all = true;
    else if (arg === "-C") opts.context = Number(argv[++i]);
    else opts.positional.push(arg);
  }
  return opts;
}

function printSearch(result) {
  for (const file of result.files) {
    console.log(file.path);
    for (const h of file.hits) {
      for (const c of h.context.filter((c) => c.line < h.line)) console.log(`  ${c.line}- ${c.text}`);
      console.log(`  ${h.line}: ${h.text}${h.symbol ? `   [${h.symbol}]` : ""}`);
      for (const c of h.context.filter((c) => c.line > h.line)) console.log(`  ${c.line}- ${c.text}`);
    }
  }
  if (result.truncated) console.log("(more matches; narrow the search)");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const db = openIndex(root);
  const started = performance.now();
  const changes = refresh(db, root, readConfig(root));
  const refreshed = performance.now() - started;
  const opts = parse(rest);
  if (command === "refresh") console.log(JSON.stringify({ ...changes, ms: Math.round(refreshed) }));
  else if (command === "search") printSearch(search(db, { patterns: opts.positional, ...opts }));
  else if (command === "symbols") {
    for (const s of symbols(db, { query: opts.positional[0], kind: opts.kind, globs: opts.globs })) {
      console.log(`${s.path}:${s.line}-${s.end_line}  ${s.kind} ${s.name}`);
    }
  } else if (command === "outline") {
    for (const s of outline(db, opts.positional[0])) console.log(`${s.line}-${s.end_line}  ${s.kind} ${s.name}`);
  } else if (command === "coverage") console.log(JSON.stringify(coverage(db), null, 1));
  else console.log("Usage: see the top of src/cli.mjs");
  db.close();
}

main();

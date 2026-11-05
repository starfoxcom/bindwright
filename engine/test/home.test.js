// engine/home.py installs setup's extras into ~/.claude. Every case runs on a
// throwaway home folder, never the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = !python && "needs Python 3.8+";

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "bw-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function home(dir, ...args) {
  const r = spawnSync(python, [join(engine, "home.py"), ...args, "--home", dir], { encoding: "utf8" });
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}

const settingsPath = (dir) => join(dir, ".claude", "settings.json");
const settings = (dir) => JSON.parse(readFileSync(settingsPath(dir), "utf8"));
const writeSettings = (dir, data) => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(settingsPath(dir), typeof data === "string" ? data : JSON.stringify(data));
};

function hookFile(dir, name, body = "print('hi')\n") {
  const file = join(dir, "src", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

test("a hook installs once, in the launcher form, beside the user's own entries", { skip }, () => {
  withHome((dir) => {
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "my-check" }] };
    writeSettings(dir, { model: "x", hooks: { PreToolUse: [mine] } });
    const file = hookFile(dir, "push-guard.py");
    for (let i = 0; i < 2; i++) {
      const r = home(dir, "install-hook", file, "--python", "/usr/bin/python3", "--matcher", "Bash|PowerShell");
      assert.equal(r.status, 0, r.stderr);
    }
    const data = settings(dir);
    assert.equal(data.model, "x");
    assert.equal(data.hooks.PreToolUse.length, 2);
    assert.deepEqual(data.hooks.PreToolUse[0], mine);
    const hook = data.hooks.PreToolUse[1].hooks[0];
    assert.equal(hook.command, "/usr/bin/python3");
    assert.deepEqual(hook.args.slice(0, 2), ["-I", "-c"]);
    assert.ok(hook.args[3].endsWith("/.claude/hooks/push-guard.py"));
    assert.equal(readFileSync(join(dir, ".claude", "hooks", "push-guard.py"), "utf8"), "print('hi')\n");
    assert.ok(existsSync(settingsPath(dir) + ".bak"));
  });
});

test("the installed push guard runs through its launcher and blocks a force push", { skip }, () => {
  withHome((dir) => {
    const guard = join(engine, "..", "_core", "global-template", "hooks", "push-guard.py");
    assert.equal(home(dir, "install-hook", guard, "--python", python, "--matcher", "Bash|PowerShell").status, 0);
    const { command, args } = settings(dir).hooks.PreToolUse[0].hooks[0];
    const call = (cmd) => spawnSync(command, args, {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }), encoding: "utf8",
    });
    assert.equal(call("git push -qf origin main").status, 2);
    const lease = call("git push --force-with-lease origin main");
    assert.equal(lease.status, 0, lease.stderr);
    assert.equal(lease.stdout, "");
  });
});

test("only the named hook leaves an entry it shares with other hooks", { skip }, () => {
  withHome((dir) => {
    const mine = { type: "command", command: "my-check" };
    const guard = (name) => ({ type: "command", command: `python "C:\\Users\\me\\.claude\\hooks\\${name}"` });
    writeSettings(dir, { hooks: { PreToolUse: [
      { matcher: "Bash|PowerShell", hooks: [mine, guard("push-guard.py"), guard("no-ai-attribution.py")] },
    ] } });
    const file = hookFile(dir, "push-guard.py");
    assert.equal(home(dir, "install-hook", file, "--python", "/usr/bin/python3", "--matcher", "Bash").status, 0);
    let entries = settings(dir).hooks.PreToolUse;
    assert.deepEqual(entries[0].hooks, [mine, guard("no-ai-attribution.py")]);
    assert.equal(entries.length, 2);
    assert.deepEqual(home(dir, "remove-hook", "no-ai-attribution.py").out, { removed_hooks: 1, deleted_file: false });
    entries = settings(dir).hooks.PreToolUse;
    assert.deepEqual(entries[0].hooks, [mine]);
    assert.deepEqual(home(dir, "remove-hook", "push-guard.py").out, { removed_hooks: 1, deleted_file: true });
    assert.deepEqual(settings(dir).hooks.PreToolUse, [{ matcher: "Bash|PowerShell", hooks: [mine] }]);
  });
});

test("an old research hook is listed and removed with its file", { skip }, () => {
  withHome((dir) => {
    const command = `py "${dir}/.claude/hooks/ctags-first.py"`;
    const old = { matcher: "Grep|Glob|Bash", hooks: [{ type: "command", command }] };
    writeSettings(dir, { hooks: { PreToolUse: [old] } });
    mkdirSync(join(dir, ".claude", "hooks"));
    writeFileSync(join(dir, ".claude", "hooks", "ctags-first.py"), "x");
    assert.deepEqual(home(dir, "list-hooks").out, { hooks: ["ctags-first.py"] });
    assert.deepEqual(home(dir, "remove-hook", "ctags-first.py").out, { removed_hooks: 1, deleted_file: true });
    assert.deepEqual(settings(dir).hooks.PreToolUse, []);
    assert.ok(!existsSync(join(dir, ".claude", "hooks", "ctags-first.py")));
  });
});

test("allow rules and the attribution settings change only what they name", { skip }, () => {
  withHome((dir) => {
    writeSettings(dir, { permissions: { allow: ["Read"], deny: ["Bash(rm -rf:*)"] } });
    assert.equal(home(dir, "allow", "Bash(git push:*)").out.changed, true);
    assert.equal(home(dir, "allow", "Bash(git push:*)").out.changed, false);
    assert.deepEqual(settings(dir).permissions, { allow: ["Read", "Bash(git push:*)"], deny: ["Bash(rm -rf:*)"] });
    assert.equal(home(dir, "disallow", "Bash(git push:*)").out.changed, true);
    assert.deepEqual(settings(dir).permissions.allow, ["Read"]);
    home(dir, "attribution-off");
    assert.deepEqual(settings(dir).attribution, { commit: "", pr: "", sessionUrl: false });
  });
});

test("a mod is copied once, listed once, and an installed copy keeps its edits", { skip }, () => {
  withHome((dir) => {
    const mod = join(dir, "pack", "session-facts");
    mkdirSync(join(mod, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mod, ".claude-plugin", "plugin.json"), "{}");
    writeSettings(dir, { env: { CLAUDE_CODE_PLUGIN_DIRS: "/other/mod" } });
    const first = home(dir, "add-mod", mod);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.out.kept_existing, false);
    const target = first.out.installed;
    writeFileSync(join(target, "rules.ts"), "mine");
    assert.equal(home(dir, "add-mod", mod).out.kept_existing, true);
    assert.equal(readFileSync(join(target, "rules.ts"), "utf8"), "mine");
    assert.equal(settings(dir).env.CLAUDE_CODE_PLUGIN_DIRS, ["/other/mod", target].join(delimiter));
    assert.equal(home(dir, "add-mod", join(dir, "pack")).status, 1);
  });
});

test("an agent file is copied once, and an installed copy keeps its edits", { skip }, () => {
  withHome((dir) => {
    const agent = join(dir, "pack", "builder.md");
    mkdirSync(dirname(agent), { recursive: true });
    writeFileSync(agent, "# builder\n");
    const target = join(dir, ".claude", "agents", "builder.md");
    const first = home(dir, "add-agent", agent);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.out, { installed: target, kept_existing: false });
    assert.equal(readFileSync(target, "utf8"), "# builder\n");
    writeFileSync(target, "mine");
    assert.deepEqual(home(dir, "add-agent", agent).out, { installed: target, kept_existing: true });
    assert.equal(readFileSync(target, "utf8"), "mine");
  });
});

test("add-agent refuses a file that is missing or is not markdown, and writes nothing", { skip }, () => {
  withHome((dir) => {
    const missing = home(dir, "add-agent", join(dir, "nope.md"));
    assert.equal(missing.status, 1);
    assert.match(missing.out.error, /Not an agent file/);
    const notMarkdown = home(dir, "add-agent", hookFile(dir, "builder.txt"));
    assert.equal(notMarkdown.status, 1);
    assert.match(notMarkdown.out.error, /Not an agent file/);
    assert.ok(!existsSync(join(dir, ".claude")));
  });
});

function styleFile(dir, body = "---\nname: Straight Talk\n---\nBe short.\n") {
  const file = join(dir, "pack", "straight-talk.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

test("an output style is copied once and turned on, and an installed copy keeps its edits", { skip }, () => {
  withHome((dir) => {
    writeSettings(dir, { outputStyle: "Explanatory", model: "opus" });
    const file = styleFile(dir);
    const target = join(dir, ".claude", "output-styles", "straight-talk.md");
    const first = home(dir, "add-style", file);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.out,
      { installed: target, kept_existing: false, outputStyle: "Straight Talk", previous: "Explanatory" });
    assert.equal(readFileSync(target, "utf8"), readFileSync(file, "utf8"));
    assert.deepEqual(settings(dir), { outputStyle: "Straight Talk", model: "opus" });
    writeFileSync(target, "---\nname: Mine\n---\nmine\n");
    const again = home(dir, "add-style", file).out;
    assert.deepEqual(again, { installed: target, kept_existing: true, outputStyle: "Mine", previous: "Straight Talk" });
    assert.equal(readFileSync(target, "utf8"), "---\nname: Mine\n---\nmine\n");
    writeFileSync(target, "no front matter\n");
    assert.equal(home(dir, "add-style", file).out.outputStyle, "straight-talk");
  });
});

test("a kept output style's name is read as YAML writes it", { skip }, () => {
  const cases = [
    ["double quotes", "---\nname: \"My Style\"\n---\nmine\n", "My Style"],
    ["single quotes", "---\nname: 'My Style'\n---\nmine\n", "My Style"],
    ["a quote inside the name", "---\nname: Alex's style\n---\nmine\n", "Alex's style"],
    ["a byte-order mark", "﻿---\nname: Mine\n---\nmine\n", "Mine"],
  ];
  for (const [label, body, want] of cases) {
    withHome((dir) => {
      const file = styleFile(dir);
      const target = join(dir, ".claude", "output-styles", "straight-talk.md");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
      assert.equal(home(dir, "add-style", file).out.outputStyle, want, label);
    });
  }
});

test("add-style refuses a missing, non-markdown or unnamed file, and writes nothing", { skip }, () => {
  withHome((dir) => {
    const cases = [
      ["missing", join(dir, "nope.md"), /Not an output style file/],
      ["not markdown", hookFile(dir, "style.txt"), /Not an output style file/],
      ["no name", styleFile(dir, "---\ndescription: x\n---\nBe short.\n"), /has no name/],
    ];
    for (const [label, file, error] of cases) {
      const r = home(dir, "add-style", file);
      assert.equal(r.status, 1, label);
      assert.match(r.out.error, error, label);
    }
    assert.ok(!existsSync(join(dir, ".claude")));
  });
});

test("a settings file that is not valid JSON is never written", { skip }, () => {
  withHome((dir) => {
    writeSettings(dir, "{ broken");
    const calls = [["allow", "Read"], ["attribution-off"], ["remove-hook", "x.py"], ["add-style", styleFile(dir)]];
    for (const args of calls) {
      const r = home(dir, ...args);
      assert.equal(r.status, 1, args.join(" "));
      assert.match(r.out.error, /not valid JSON/);
    }
    assert.equal(readFileSync(settingsPath(dir), "utf8"), "{ broken");
    assert.ok(!existsSync(join(dir, ".claude", "output-styles")));
    writeSettings(dir, { hooks: { PreToolUse: {} } });
    assert.match(home(dir, "list-hooks").out.error, /PreToolUse is not a list/);
  });
});

test("a missing settings file starts empty, and bad usage is refused", { skip }, () => {
  withHome((dir) => {
    assert.deepEqual(home(dir, "list-hooks").out, { hooks: [] });
    assert.equal(home(dir, "install-hook", hookFile(dir, "x.py"), "--matcher", "Bash").status, 1);
    assert.equal(home(dir, "nonsense").status, 1);
  });
});

const SPANISH_RULE = "# Work language\n\nWrite commit messages and code comments in Spanish, "
  + "unless the project's own rules name a language for them.\n";
const workRule = (dir) => join(dir, ".claude", "rules", "work-language.md");
const asText = (data) => (typeof data === "string" ? data : JSON.stringify(data));

// One set-language run on its own home, from the settings and rule file the row starts with.
function checkLanguageRow({ label, name, before, ruleBefore, previous, after, rule, error }) {
  withHome((dir) => {
    if (before !== undefined) writeSettings(dir, before);
    if (ruleBefore !== undefined) {
      mkdirSync(dirname(workRule(dir)), { recursive: true });
      writeFileSync(workRule(dir), ruleBefore);
    }
    const r = home(dir, "set-language", name);
    if (error) {
      assert.equal(r.status, 1, label);
      assert.match(r.out.error, error, label);
      assert.equal(readFileSync(settingsPath(dir), "utf8"), asText(before), label);
      assert.ok(!existsSync(workRule(dir)), label);
      return;
    }
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.deepEqual(r.out, { language: name, previous, rule: rule ? workRule(dir) : null }, label);
    assert.deepEqual(settings(dir), after, label);
    assert.equal(existsSync(workRule(dir)), rule, label);
    if (rule) assert.equal(readFileSync(workRule(dir), "utf8"), SPANISH_RULE, label);
  });
}

test("set-language sets the work language, its rule file and the settings key", { skip }, () => {
  const rows = [
    {
      label: "spanish on an empty home",
      name: "spanish", previous: null, after: { language: "spanish" }, rule: true,
    },
    {
      label: "spanish keeps the other settings keys",
      name: "spanish", before: { model: "opus" }, previous: null,
      after: { model: "opus", language: "spanish" }, rule: true,
    },
    {
      label: "spanish again changes no settings value",
      name: "spanish", before: { model: "opus", language: "spanish" }, previous: "spanish",
      after: { model: "opus", language: "spanish" }, rule: true,
    },
    {
      label: "spanish rewrites an edited rule file",
      name: "spanish", ruleBefore: "mine\n", previous: null, after: { language: "spanish" }, rule: true,
    },
    {
      label: "english after spanish drops the key and the rule file",
      name: "english", before: { model: "opus", language: "spanish" }, ruleBefore: SPANISH_RULE,
      previous: "spanish", after: { model: "opus" }, rule: false,
    },
    {
      label: "english keeps a language the person set by hand",
      name: "english", before: { language: "japanese" }, previous: "japanese",
      after: { language: "japanese" }, rule: false,
    },
    {
      label: "an unknown language is refused and nothing is written",
      name: "klingon", before: { model: "opus" },
      error: /Unknown work language: klingon; use english or spanish/,
    },
    {
      label: "a settings file that is not valid JSON is refused and left alone",
      name: "spanish", before: "{ broken", error: /not valid JSON/,
    },
  ];
  for (const row of rows) checkLanguageRow(row);
});

test("find-python names a system interpreter", { skip }, () => {
  const r = spawnSync(python, [join(engine, "home.py"), "find-python"], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.ok(out.python || out.error, r.stdout);
  if (out.python) assert.ok(existsSync(out.python), out.python);
});

// engine/home.py installs setup's extras into ~/.claude. Every case runs on a
// throwaway home folder, never the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  return homeWithEnv({}, dir, ...args);
}

function homeWithEnv(env, dir, ...args) {
  const options = { encoding: "utf8", env: { ...process.env, ...env } };
  const r = spawnSync(python, [join(engine, "home.py"), ...args, "--home", dir], options);
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
    // An interpreter PATH does not reach stays an absolute path.
    const interpreterPath = join(dir, "py", "python3");
    for (let i = 0; i < 2; i++) {
      const r = home(dir, "install-hook", file, "--python", interpreterPath, "--matcher", "Bash|PowerShell");
      assert.equal(r.status, 0, r.stderr);
    }
    const data = settings(dir);
    assert.equal(data.model, "x");
    assert.equal(data.hooks.PreToolUse.length, 2);
    assert.deepEqual(data.hooks.PreToolUse[0], mine);
    const hook = data.hooks.PreToolUse[1].hooks[0];
    assert.equal(hook.command, interpreterPath);
    assert.deepEqual(hook.args.slice(0, 2), ["-I", "-c"]);
    assert.ok(hook.args[3].endsWith("/.claude/hooks/push-guard.py"));
    assert.equal(readFileSync(join(dir, ".claude", "hooks", "push-guard.py"), "utf8"), "print('hi')\n");
    assert.ok(existsSync(settingsPath(dir) + ".bak"));
  });
});

function withPath(dirs, fn) {
  const saved = process.env.PATH;
  process.env.PATH = [...dirs, saved].join(delimiter);
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

function interpreter(dir) {
  const file = join(dir, process.platform === "win32" ? "python3.exe" : "python3");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  chmodSync(file, 0o755);
  return file;
}

test("a hook whose interpreter PATH resolves to installs as the bare name", { skip }, () => {
  withHome((dir) => {
    const bin = join(dir, "bin");
    const python3 = interpreter(bin);
    const file = hookFile(dir, "push-guard.py");
    withPath([bin], () => {
      assert.equal(home(dir, "install-hook", file, "--python", python3, "--matcher", "Bash").status, 0);
    });
    assert.equal(settings(dir).hooks.PreToolUse[0].hooks[0].command, "python3");
  });
});

test("a hook whose interpreter is not on PATH keeps its absolute path", { skip }, () => {
  withHome((dir) => {
    const python3 = interpreter(join(dir, "elsewhere"));
    const file = hookFile(dir, "push-guard.py");
    withPath([join(dir, "bin")], () => {
      assert.equal(home(dir, "install-hook", file, "--python", python3, "--matcher", "Bash").status, 0);
    });
    assert.equal(settings(dir).hooks.PreToolUse[0].hooks[0].command, python3);
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

test("the installed attribution guard brings its modules and refuses an AI co-author", { skip }, () => {
  withHome((dir) => {
    const guard = join(engine, "..", "_core", "global-template", "hooks", "no-ai-attribution.py");
    assert.equal(home(dir, "install-hook", guard, "--python", python, "--matcher", "Bash|PowerShell").status, 0);
    const { command, args } = settings(dir).hooks.PreToolUse[0].hooks[0];
    const trailer = "Co-Authored-By: " + "Cla" + "ude <noreply@" + "anthropic.com>";
    const call = spawnSync(command, args, { encoding: "utf8",
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `git commit -m x -m '${trailer}'` } }) });
    assert.match(call.stdout, /"deny"/, call.stderr);
    const modules = join(dir, ".claude", "hooks", "no_ai_attribution");
    assert.ok(existsSync(join(modules, "shell.py")));
    for (const name of ["x", ".py", "...py", "../projects.py", join(dir, "abs.py")]) {
      assert.equal(home(dir, "remove-hook", name).status, 1, name);
    }
    assert.ok(existsSync(modules));
    home(dir, "remove-hook", "no-ai-attribution.py");
    assert.ok(!existsSync(modules));
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

// A mod folder as the plugin ships it: a manifest plus the given files, by relative path.
function shipMod(dir, files) {
  const mod = join(dir, "pack", "usage-guard");
  for (const [rel, text] of Object.entries({ ".claude-plugin/plugin.json": "{}", ...files })) {
    mkdirSync(dirname(join(mod, rel)), { recursive: true });
    writeFileSync(join(mod, rel), text);
  }
  return mod;
}

const modStatus = (dir, mod) => home(dir, "mod-status", mod).out;
const updateMod = (dir, mod, ...flags) => home(dir, "update-mod", mod, ...flags);
const recordPath = (installed) => join(installed, ".bindwright-installed.json");

test("an installed mod reads back as current, and a mod never installed as missing", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/rules.ts": "v1", "user-files.json": '{"paths": []}' });
    assert.equal(modStatus(dir, mod).state, "missing");
    const installed = home(dir, "add-mod", mod).out.installed;
    const record = JSON.parse(readFileSync(recordPath(installed), "utf8"));
    assert.deepEqual(Object.keys(record.sha256), [".claude-plugin/plugin.json", "hooks/rules.ts", "user-files.json"]);
    assert.deepEqual(modStatus(dir, mod),
      { installed, state: "current", files: {}, version: null, shipped_version: null });
  });
});

test("mod-status names the installed version and the shipped one", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { ".claude-plugin/plugin.json": '{"version": "1.2.0"}', "hooks/rules.ts": "v1" });
    assert.equal(modStatus(dir, mod).version, null, "nothing installed yet");
    const installed = home(dir, "add-mod", mod).out.installed;
    writeFileSync(join(mod, ".claude-plugin", "plugin.json"), '{"version": "1.3.0"}');
    const status = modStatus(dir, mod);
    assert.equal(status.version, "1.2.0");
    assert.equal(status.shipped_version, "1.3.0");
    assert.equal(updateMod(dir, mod).out.version, "1.2.0", "update-mod reports the version it replaced");
    assert.equal(modStatus(dir, mod).version, "1.3.0");
    writeFileSync(join(installed, ".claude-plugin", "plugin.json"), "not json");
    assert.equal(modStatus(dir, mod).version, null, "an unreadable manifest names no version");
  });
});

test("a changed shipped file makes the installed copy older, and update-mod replaces it", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/rules.ts": "v1" });
    const installed = home(dir, "add-mod", mod).out.installed;
    writeFileSync(join(mod, "hooks", "rules.ts"), "v2");
    assert.deepEqual(modStatus(dir, mod).files, { "hooks/rules.ts": "replace" });
    assert.equal(modStatus(dir, mod).state, "older");
    const r = updateMod(dir, mod);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.updated, ["hooks/rules.ts"]);
    assert.equal(readFileSync(join(installed, "hooks", "rules.ts"), "utf8"), "v2");
    assert.equal(modStatus(dir, mod).state, "current");
  });
});

test("update-mod keeps an edited file and sets the shipped text beside it as .new", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/rules.ts": "v1" });
    const installed = home(dir, "add-mod", mod).out.installed;
    const rules = join(installed, "hooks", "rules.ts");
    writeFileSync(rules, "mine");
    assert.equal(modStatus(dir, mod).state, "current", "an edit with nothing newer shipped");
    writeFileSync(join(mod, "hooks", "rules.ts"), "v2");
    assert.equal(modStatus(dir, mod).state, "edited");
    const r = updateMod(dir, mod);
    assert.deepEqual(r.out.kept, ["hooks/rules.ts"]);
    assert.deepEqual(r.out.updated, []);
    assert.equal(readFileSync(rules, "utf8"), "mine");
    assert.equal(readFileSync(rules + ".new", "utf8"), "v2");
    assert.equal(modStatus(dir, mod).state, "current", "the offered text is not offered again");
    writeFileSync(join(mod, "hooks", "rules.ts"), "v3");
    assert.equal(modStatus(dir, mod).state, "edited", "a newer shipped text is offered");
  });
});

test("a dropped file the user never edited is removed, and a dropped edited one stays", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/old.ts": "old", "hooks/kept.ts": "kept" });
    const installed = home(dir, "add-mod", mod).out.installed;
    writeFileSync(join(installed, "hooks", "kept.ts"), "mine");
    rmSync(join(mod, "hooks", "old.ts"));
    rmSync(join(mod, "hooks", "kept.ts"));
    assert.deepEqual(modStatus(dir, mod).files, { "hooks/old.ts": "remove", "hooks/kept.ts": "edited" });
    const r = updateMod(dir, mod);
    assert.deepEqual(r.out.removed, ["hooks/old.ts"]);
    assert.deepEqual(r.out.kept, []);
    assert.equal(existsSync(join(installed, "hooks", "old.ts")), false);
    assert.equal(readFileSync(join(installed, "hooks", "kept.ts"), "utf8"), "mine");
    assert.equal(modStatus(dir, mod).state, "current");
  });
});

test("an update stopped between writing a file and recording it is finished by the next one", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/rules.ts": "v1" });
    const installed = home(dir, "add-mod", mod).out.installed;
    const rules = join(installed, "hooks", "rules.ts");
    // The shipped v2 and a new file reached the disk, but the record still holds v1 and lacks the new file.
    writeFileSync(join(mod, "hooks", "rules.ts"), "v2");
    writeFileSync(rules, "v2");
    writeFileSync(join(mod, "hooks", "extra.ts"), "x");
    writeFileSync(join(installed, "hooks", "extra.ts"), "x");
    assert.deepEqual(modStatus(dir, mod),
      { installed, state: "older", files: {}, version: null, shipped_version: null });
    const r = updateMod(dir, mod);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.updated, []);
    assert.equal(modStatus(dir, mod).state, "current");
    writeFileSync(join(mod, "hooks", "rules.ts"), "v3");
    const files = modStatus(dir, mod).files;
    assert.deepEqual(files, { "hooks/rules.ts": "replace" }, "the unedited file is not taken for an edit");
  });
});

test("a user list updates while unedited, gets a .new once edited, and is kept with no record", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/rules.ts": "v1", "user-files.json": '{"paths": ["hooks/rules.ts"]}' });
    const installed = home(dir, "add-mod", mod).out.installed;
    const rules = join(installed, "hooks", "rules.ts");
    const ship = (text) => writeFileSync(join(mod, "hooks", "rules.ts"), text);
    ship("v2");
    assert.deepEqual(updateMod(dir, mod).out.updated, ["hooks/rules.ts"]);
    assert.equal(readFileSync(rules, "utf8"), "v2");
    writeFileSync(rules, "mine");
    ship("v3");
    assert.deepEqual(updateMod(dir, mod).out.kept, ["hooks/rules.ts"]);
    assert.equal(readFileSync(rules, "utf8"), "mine");
    assert.equal(readFileSync(rules + ".new", "utf8"), "v3");
    rmSync(recordPath(installed));
    ship("v4");
    assert.deepEqual(modStatus(dir, mod).files, { "hooks/rules.ts": "edited" });
    assert.deepEqual(updateMod(dir, mod, "--adopt").out.kept, ["hooks/rules.ts"]);
    assert.equal(readFileSync(rules, "utf8"), "mine");
    assert.equal(readFileSync(rules + ".new", "utf8"), "v4");
  });
});

test("a record key outside the mod folder is refused before anything is removed", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/rules.ts": "v1" });
    const installed = home(dir, "add-mod", mod).out.installed;
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "keep");
    const hash = createHash("sha256").update("keep").digest("hex");
    for (const key of ["../../outside.txt", outside.replaceAll("\\", "/"), "hooks\\rules.ts", "hooks//rules.ts"]) {
      writeFileSync(recordPath(installed), JSON.stringify({ sha256: { [key]: hash } }));
      const r = updateMod(dir, mod);
      assert.equal(r.status, 1, key);
      assert.match(r.out.error, /Not an install record/, key);
    }
    assert.equal(readFileSync(outside, "utf8"), "keep");
  });
});

test("every shipped mod that keeps a rules.ts list names it as the user's", () => {
  const mods = join(engine, "..", "_core", "global-template", "mods");
  for (const name of readdirSync(mods)) {
    if (!existsSync(join(mods, name, "hooks", "rules.ts"))) continue;
    const listed = JSON.parse(readFileSync(join(mods, name, "user-files.json"), "utf8")).paths;
    assert.ok(listed.includes("hooks/rules.ts"), name);
  }
});

test("an unrecorded copy is left alone until --adopt, which replaces it and writes the record", { skip }, () => {
  withHome((dir) => {
    const mod = shipMod(dir, { "hooks/rules.ts": "v1" });
    const installed = home(dir, "add-mod", mod).out.installed;
    rmSync(recordPath(installed));
    assert.deepEqual(modStatus(dir, mod),
      { installed, state: "unrecorded", files: {}, version: null, shipped_version: null });
    writeFileSync(join(mod, "hooks", "rules.ts"), "v2");
    assert.equal(modStatus(dir, mod).state, "unrecorded");
    assert.deepEqual(modStatus(dir, mod).files, { "hooks/rules.ts": "replace" });
    assert.deepEqual(updateMod(dir, mod).out.updated, []);
    assert.equal(readFileSync(join(installed, "hooks", "rules.ts"), "utf8"), "v1");
    assert.equal(existsSync(recordPath(installed)), false);
    assert.deepEqual(updateMod(dir, mod, "--adopt").out.updated, ["hooks/rules.ts"]);
    assert.equal(readFileSync(join(installed, "hooks", "rules.ts"), "utf8"), "v2");
    assert.equal(existsSync(recordPath(installed)), true);
    assert.equal(modStatus(dir, mod).state, "current");
  });
});

test("the tasks mod turns on the task tools it answers and leaves them on; other mods set nothing", { skip }, () => {
  withHome((dir) => {
    const add = (name) => {
      const mod = join(dir, "pack", name);
      mkdirSync(join(mod, ".claude-plugin"), { recursive: true });
      writeFileSync(join(mod, ".claude-plugin", "plugin.json"), "{}");
      return home(dir, "add-mod", mod).out;
    };
    writeSettings(dir, { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" } });
    assert.deepEqual(add("ci-watch").env_set, []);
    assert.equal(settings(dir).env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "0");
    assert.deepEqual(add("tasks").env_set, ["CLAUDE_CODE_ENABLE_TODO_TOOLS"]);
    assert.equal(settings(dir).env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
    // Installed again (a later setup or join): the setting holds, nothing to change.
    const again = add("tasks");
    assert.equal(again.kept_existing, true);
    assert.deepEqual(again.env_set, []);
    // The setting only turns on a CLI feature, so it outlives the mod.
    home(dir, "remove-mod", "tasks");
    assert.equal(settings(dir).env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
  });
});

test("mods are listed in row order whatever order they are added in", { skip }, () => {
  withHome((dir) => {
    const add = (name) => {
      const mod = join(dir, "pack", name);
      mkdirSync(join(mod, ".claude-plugin"), { recursive: true });
      writeFileSync(join(mod, ".claude-plugin", "plugin.json"), "{}");
      return home(dir, "add-mod", mod).out.installed;
    };
    writeSettings(dir, { env: { CLAUDE_CODE_PLUGIN_DIRS: "/mine/early" } });
    const added = ["mods", "session-facts", "mine-late", "shared-pc", "tasks"].map((n) => [n, add(n)]);
    const at = Object.fromEntries(added);
    const want = ["/mine/early", at["shared-pc"], at.tasks, at["session-facts"], at.mods, at["mine-late"]];
    assert.equal(settings(dir).env.CLAUDE_CODE_PLUGIN_DIRS, want.join(delimiter));
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
    ["a header never closed, which is no header", "---\nname: Mine\nmine\n", "straight-talk"],
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

const fingerprint = (text) => createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");

test("update-style replaces only an unedited earlier shipped copy", { skip }, () => {
  const OLD = "---\nname: Straight Talk\n---\nBe short.\n";
  const NEW = "---\nname: Straight Talk\n---\nBe short and sound like a person.\n";
  const cases = [
    ["nothing installed", null, "missing", false],
    ["the current text", NEW, "current", false],
    ["the current text with CRLF line endings", NEW.replaceAll("\n", "\r\n"), "current", false],
    ["an earlier shipped copy", OLD, "older", true],
    ["an earlier shipped copy with CRLF line endings", OLD.replaceAll("\n", "\r\n"), "older", true],
    ["an earlier shipped copy with a byte order mark", `﻿${OLD}`, "older", true],
    ["a copy with the user's edits", "---\nname: Straight Talk\n---\nBe short. Mine.\n", "edited", false],
    ["an edited copy saved as Windows-1252",
      Buffer.from("---\nname: Straight Talk\n---\nBe short, se\xf1or.\n", "latin1"), "edited", false],
  ];
  for (const [label, installed, state, replaced] of cases) {
    withHome((dir) => {
      const file = styleFile(dir, NEW);
      writeFileSync(join(dirname(file), "straight-talk.retired.json"), JSON.stringify({ sha256: [fingerprint(OLD)] }));
      const target = join(dir, ".claude", "output-styles", "straight-talk.md");
      if (installed !== null) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, installed);
      }
      assert.deepEqual(home(dir, "style-status", file).out, { installed: target, state }, label);
      assert.deepEqual(home(dir, "update-style", file).out, { installed: target, state, replaced }, label);
      const after = installed === null ? null : readFileSync(target);
      assert.deepEqual(after, installed === null ? null : Buffer.from(replaced ? NEW : installed), label);
    });
  }
  withHome((dir) => {
    const file = styleFile(dir, NEW);
    writeFileSync(join(dirname(file), "straight-talk.retired.json"), JSON.stringify({ sha256: [fingerprint(OLD)] }));
    const kept = join(dir, "dotfiles-straight-talk.md");
    writeFileSync(kept, OLD);
    const target = join(dir, ".claude", "output-styles", "straight-talk.md");
    mkdirSync(dirname(target), { recursive: true });
    try {
      symlinkSync(kept, target, "file");
    } catch {
      return; // This machine cannot make file links (Windows without developer mode).
    }
    assert.deepEqual(home(dir, "update-style", file).out, { installed: target, state: "linked", replaced: false });
    assert.equal(readFileSync(kept, "utf8"), OLD, "the file a link points to stays as it was");
  });
  withHome((dir) => {
    const file = styleFile(dir, NEW);
    const target = join(dir, ".claude", "output-styles", "straight-talk.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, OLD);
    const unlisted = home(dir, "update-style", file).out;
    assert.deepEqual(unlisted, { installed: target, state: "edited", replaced: false }, "no list of earlier copies");
    const notStyle = home(dir, "style-status", join(dirname(file), "straight-talk.txt"));
    assert.equal(notStyle.status, 1);
    assert.match(notStyle.out.error, /Not an output style file/);
  });
  for (const sidecar of ["{", "[]", '{"sha256": "abc"}']) {
    withHome((dir) => {
      const file = styleFile(dir, NEW);
      writeFileSync(join(dirname(file), "straight-talk.retired.json"), sidecar);
      const target = join(dir, ".claude", "output-styles", "straight-talk.md");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, OLD);
      const r = home(dir, "style-status", file);
      assert.equal(r.status, 1, sidecar);
      assert.match(r.out.error, /Not a list of earlier copies/, sidecar);
    });
  }
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

test("hook-status names the shipped hooks the record lacks and whether each matches", { skip }, () => {
  withHome((dir) => {
    const shipped = join(dir, "src");
    const guard = hookFile(dir, "no-ai-attribution.py", "guard\n");
    hookFile(dir, "no_ai_attribution/routes.py", "routes\n");
    hookFile(dir, "push-guard.py", "push\n");
    for (const file of [guard, join(shipped, "push-guard.py")]) {
      assert.equal(home(dir, "install-hook", file, "--python", python, "--matcher", "Bash").status, 0);
    }
    const old = { matcher: "Grep", hooks: [{ type: "command", command: `py "${dir}/.claude/hooks/ctags-first.py"` }] };
    const elsewhere = { matcher: "Bash", hooks: [{ type: "command", command: `py "${dir}/mine/tool-rules.py"` }] };
    hookFile(dir, "tool-rules.py", "rules\n");
    // A leftover copy in the hooks folder does not make the entry that runs another file Bindwright's.
    writeFileSync(join(dir, ".claude", "hooks", "tool-rules.py"), "rules\n");
    const entries = [...settings(dir).hooks.PreToolUse, old, elsewhere];
    writeSettings(dir, { ...settings(dir), hooks: { PreToolUse: entries } });
    const status = () => home(dir, "hook-status", shipped).out.hooks;
    const both = { recorded: true, matches: true, linked: false };
    const all = { "no-ai-attribution.py": both, "push-guard.py": both };
    assert.deepEqual(status(), all, "a hook not shipped, or with no copy in the hooks folder, is left out");
    rmSync(join(dir, ".bindwright", "hooks.json"));
    rmSync(join(dir, ".claude", "hooks", "no_ai_attribution"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hooks", "push-guard.py"), "push\r\n");
    assert.deepEqual(status(), {
      "no-ai-attribution.py": { recorded: false, matches: false, linked: false },
      "push-guard.py": { recorded: false, matches: true, linked: false },
    });
    // A matching copy is only recorded: its settings entry stays, and a differing one is refused.
    const before = settings(dir);
    assert.equal(home(dir, "adopt-hook", join(shipped, "push-guard.py")).status, 0);
    assert.deepEqual(settings(dir), before);
    assert.equal(status()["push-guard.py"].recorded, true);
    assert.match(home(dir, "adopt-hook", guard).out.error, /differs from the shipped one/);
    // A package folder the user keeps as a link is reported, and adopt-hook leaves it.
    const kept = join(dir, "dotfiles", "no_ai_attribution");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "routes.py"), "routes\n");
    const link = join(dir, ".claude", "hooks", "no_ai_attribution");
    symlinkSync(kept, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(status()["no-ai-attribution.py"].linked, true);
    assert.match(home(dir, "adopt-hook", guard).out.error, /is a link/);
    assert.equal(readFileSync(join(kept, "routes.py"), "utf8"), "routes\n");
    // A hooks folder that is itself a link counts for every hook in it.
    const hooks = join(dir, ".claude", "hooks");
    renameSync(hooks, join(dir, "dotfiles", "hooks"));
    symlinkSync(join(dir, "dotfiles", "hooks"), hooks, process.platform === "win32" ? "junction" : "dir");
    assert.equal(status()["push-guard.py"].linked, true);
    assert.match(home(dir, "adopt-hook", join(shipped, "push-guard.py")).out.error, /is a link/);
    rmSync(hooks);
    renameSync(join(dir, "dotfiles", "hooks"), hooks);
    // So is one module linked inside a real package folder, when this machine can make file links.
    rmSync(link);
    mkdirSync(link);
    try {
      symlinkSync(join(kept, "routes.py"), join(link, "routes.py"), "file");
    } catch {
      return; // Windows without developer mode makes no file links.
    }
    assert.equal(status()["no-ai-attribution.py"].linked, true);
    assert.match(home(dir, "adopt-hook", guard).out.error, /is a link/);
  });
});

test("hook-status finds a hook installed under a home given with a .. in its path", { skip }, () => {
  withHome((dir) => {
    // Node's join would fold the .. away, so the path is spelled out.
    mkdirSync(join(dir, "x"));
    const roundabout = `${dir}/x/..`;
    const file = hookFile(dir, "push-guard.py", "push\n");
    assert.equal(home(roundabout, "install-hook", file, "--python", python, "--matcher", "Bash").status, 0);
    const status = home(roundabout, "hook-status", join(dir, "src")).out.hooks;
    assert.deepEqual(status, { "push-guard.py": { recorded: true, matches: true, linked: false } });
  });
});

test("a null hook event is skipped, so a guard beside it still lists and removes", { skip }, () => {
  withHome((dir) => {
    const file = hookFile(dir, "push-guard.py");
    assert.equal(home(dir, "install-hook", file, "--python", "/usr/bin/python3", "--matcher", "Bash").status, 0);
    writeSettings(dir, { ...settings(dir), hooks: { ...settings(dir).hooks, Stop: null } });
    assert.ok(home(dir, "list-hooks").out.hooks.some((h) => JSON.stringify(h).includes("push-guard.py")));
    assert.equal(home(dir, "remove-hook", "push-guard.py").out.removed_hooks, 1);
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

test("plugin-auto-update writes the wrights marketplace's autoUpdate and keeps the rest", { skip }, () => {
  const source = { source: "github", repo: "a-fork/wrights" };
  const repo = ["--repo", "a-fork/wrights"];
  const rows = [
    ["on with no settings file adds the entry from the repo given", ["on", ...repo], undefined,
      { extraKnownMarketplaces: { wrights: { source, autoUpdate: true } } }, true],
    ["on keeps the entry's own source, over any repo given, and the other marketplaces", ["on", ...repo],
      { model: "opus", extraKnownMarketplaces: { other: { source: {} }, wrights: { source: { source: "git" } } } },
      { model: "opus", extraKnownMarketplaces: { other: { source: {} },
        wrights: { source: { source: "git" }, autoUpdate: true } } }, true],
    ["on again changes nothing", ["on"], { extraKnownMarketplaces: { wrights: { source, autoUpdate: true } } },
      { extraKnownMarketplaces: { wrights: { source, autoUpdate: true } } }, false],
    ["off writes false, which outranks the /plugin toggle", ["off"],
      { extraKnownMarketplaces: { wrights: { source, autoUpdate: true } } },
      { extraKnownMarketplaces: { wrights: { source, autoUpdate: false } } }, true],
    ["off with no entry has nothing to turn off", ["off"], { model: "opus" }, { model: "opus" }, false],
  ];
  for (const [label, args, before, after, changed] of rows) {
    withHome((dir) => {
      if (before !== undefined) writeSettings(dir, before);
      const r = home(dir, "plugin-auto-update", ...args);
      assert.equal(r.status, 0, label);
      assert.equal(r.out.changed, changed, label);
      assert.deepEqual(settings(dir), after, label);
    });
  }
  const refused = [
    ["a state other than on or off", ["maybe"], { model: "opus" }, /Use on or off, not maybe/],
    ["on with no entry and no repo", ["on"], { model: "opus" }, /pass --repo/],
    ["a repo that is not owner/name", ["on", "--repo", "a b"], { model: "opus" }, /owner\/name/],
    ["a wrights entry that is not an object", ["on"], { extraKnownMarketplaces: { wrights: true } },
      /is not an object/],
    ["a settings file that is not valid JSON", ["on"], "{ broken", /not valid JSON/],
  ];
  for (const [label, args, before, error] of refused) {
    withHome((dir) => {
      writeSettings(dir, before);
      const r = home(dir, "plugin-auto-update", ...args);
      assert.equal(r.status, 1, label);
      assert.match(r.out.error, error, label);
      assert.equal(readFileSync(settingsPath(dir), "utf8"), asText(before), label);
    });
  }
  withHome((dir) => {
    writeSettings(dir, { env: { DISABLE_AUTOUPDATER: "1" } });
    const r = home(dir, "plugin-auto-update", "on", "--repo", "starfoxcom/wrights");
    assert.ok(r.out.blocked_by.includes("DISABLE_AUTOUPDATER"));
    // The force in the shell outweighs a blocker in settings, as Claude Code reads them together.
    const args = [join(engine, "home.py"), "plugin-auto-update", "on", "--home", dir];
    const env = { ...process.env, FORCE_AUTOUPDATE_PLUGINS: "1" };
    const forced = JSON.parse(spawnSync(python, args, { encoding: "utf8", env }).stdout);
    assert.deepEqual(forced.blocked_by, []);
  });
});

test("find-python names a system interpreter", { skip }, () => {
  const r = spawnSync(python, [join(engine, "home.py"), "find-python"], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.ok(out.python || out.error, r.stdout);
  if (out.python) assert.ok(existsSync(out.python), out.python);
});

test("a removed mod leaves the folder list, keeps the user's other entries, and its folder goes", { skip }, () => {
  withHome((dir) => {
    const mod = join(dir, "pack", "session-facts");
    mkdirSync(join(mod, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mod, ".claude-plugin", "plugin.json"), "{}");
    writeSettings(dir, { env: { CLAUDE_CODE_PLUGIN_DIRS: "/other/mod", KEEP: "1" } });
    const target = home(dir, "add-mod", mod).out.installed;
    const removed = home(dir, "remove-mod", "session-facts");
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(removed.out, { removed: target, unlisted: true, deleted_folder: true });
    assert.deepEqual(settings(dir).env, { CLAUDE_CODE_PLUGIN_DIRS: "/other/mod", KEEP: "1" });
    assert.ok(!existsSync(target));
    assert.deepEqual(home(dir, "remove-mod", "session-facts").out,
      { removed: target, unlisted: false, deleted_folder: false });
  });
});

test("a linked mod folder is refused before its entry leaves the folder list", { skip }, () => {
  withHome((dir) => {
    const real = join(dir, "pack", "tasks");
    const target = join(dir, ".claude", "mods", "tasks");
    mkdirSync(real, { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    // A junction on Windows, which os.path.islink does not report.
    symlinkSync(real, target, process.platform === "win32" ? "junction" : "dir");
    writeSettings(dir, { env: { CLAUDE_CODE_PLUGIN_DIRS: target } });
    const removed = home(dir, "remove-mod", "tasks");
    assert.equal(removed.status, 1, removed.stderr);
    assert.match(removed.out.error, /The mod folder is a link/);
    assert.deepEqual(settings(dir).env, { CLAUDE_CODE_PLUGIN_DIRS: target });
    assert.ok(existsSync(real));
  });
});

test("the last listed mod takes the folder list with it", { skip }, () => {
  withHome((dir) => {
    const mod = join(dir, "pack", "session-facts");
    mkdirSync(join(mod, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mod, ".claude-plugin", "plugin.json"), "{}");
    home(dir, "add-mod", mod);
    home(dir, "remove-mod", "session-facts");
    assert.deepEqual(settings(dir).env, {});
  });
});

test("an agent file is removed, and a name that is a path is refused", { skip }, () => {
  withHome((dir) => {
    const agent = join(dir, "pack", "builder.md");
    mkdirSync(dirname(agent), { recursive: true });
    writeFileSync(agent, "# builder\n");
    const target = home(dir, "add-agent", agent).out.installed;
    assert.deepEqual(home(dir, "remove-agent", "builder.md").out, { removed: target, deleted_file: true });
    assert.ok(!existsSync(target));
    for (const name of ["../settings.json", "..", "a\\b.md"]) {
      const refused = home(dir, "remove-agent", name);
      assert.equal(refused.status, 1, name);
      assert.match(refused.out.error, /Not an agent file name/, name);
    }
  });
});

test("a removed output style is turned off only when it is the one in use", { skip }, () => {
  withHome((dir) => {
    writeSettings(dir, { model: "opus" });
    const target = home(dir, "add-style", styleFile(dir)).out.installed;
    const removed = home(dir, "remove-style", "straight-talk.md").out;
    assert.deepEqual(removed, { removed: target, deleted_file: true, turned_off: true, outputStyle: "Straight Talk" });
    assert.deepEqual(settings(dir), { model: "opus" });
    home(dir, "add-style", styleFile(dir));
    writeSettings(dir, { outputStyle: "Explanatory" });
    assert.equal(home(dir, "remove-style", "straight-talk.md").out.turned_off, false);
    assert.deepEqual(settings(dir), { outputStyle: "Explanatory" });
  });
});
const PYTHON = "/usr/bin/python3";
const EVENTS = "SessionStart,UserPromptSubmit";

test("--events installs one entry per event, with no matcher, beside the user's own entries", { skip }, () => {
  withHome((dir) => {
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "my-check" }] };
    writeSettings(dir, { hooks: { SessionStart: [mine] } });
    const file = hookFile(dir, "session-title.py");
    const r = home(dir, "install-hook", file, "--python", PYTHON, "--events", EVENTS);
    assert.equal(r.status, 0, r.stderr);
    const { hooks } = settings(dir);
    assert.deepEqual(hooks.SessionStart[0], mine);
    assert.equal(hooks.SessionStart.length, 2);
    assert.ok(!("matcher" in hooks.SessionStart[1]));
    assert.equal(hooks.UserPromptSubmit.length, 1);
    assert.ok(!("matcher" in hooks.UserPromptSubmit[0]));
    assert.deepEqual(hooks.UserPromptSubmit[0].hooks, hooks.SessionStart[1].hooks);
    const hook = hooks.UserPromptSubmit[0].hooks[0];
    assert.ok([PYTHON, "python3"].includes(hook.command), hook.command);
    assert.deepEqual(hook.args.slice(0, 2), ["-I", "-c"]);
    assert.ok(hook.args[3].endsWith("/.claude/hooks/session-title.py"));
    assert.equal(hooks.PreToolUse, undefined);
  });
});

test("--block-on-failure sets onFailure on the hook, and leaving it out sets none", { skip }, () => {
  withHome((dir) => {
    const file = hookFile(dir, "push-guard.py");
    const install = (...flags) => home(dir, "install-hook", file, "--python", PYTHON, "--matcher", "Bash", ...flags);
    assert.equal(install("--block-on-failure").status, 0);
    assert.equal(settings(dir).hooks.PreToolUse[0].hooks[0].onFailure, "block");
    assert.equal(install().status, 0);
    const hook = settings(dir).hooks.PreToolUse[0].hooks[0];
    assert.ok(!("onFailure" in hook));
  });
});

test("a registered hook whose file is gone exits 0 through its launcher", { skip }, () => {
  withHome((dir) => {
    const file = hookFile(dir, "push-guard.py");
    assert.equal(home(dir, "install-hook", file, "--python", python, "--matcher", "Bash").status, 0);
    const { command, args } = settings(dir).hooks.PreToolUse[0].hooks[0];
    rmSync(join(dir, ".claude", "hooks", "push-guard.py"));
    const r = spawnSync(command, args, { input: "{}", encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});

test("reinstalling with --events replaces its own entries under every event it names", { skip }, () => {
  withHome((dir) => {
    const file = hookFile(dir, "session-title.py");
    const install = () => home(dir, "install-hook", file, "--python", PYTHON, "--events", EVENTS);
    assert.equal(install().status, 0);
    assert.equal(install().status, 0);
    const { hooks } = settings(dir);
    assert.equal(hooks.SessionStart.length, 1);
    assert.equal(hooks.UserPromptSubmit.length, 1);
  });
});

test("remove-hook and list-hooks cover every event under hooks, not only PreToolUse", { skip }, () => {
  withHome((dir) => {
    const guard = hookFile(dir, "push-guard.py");
    const title = hookFile(dir, "session-title.py");
    assert.equal(home(dir, "install-hook", guard, "--python", "/usr/bin/python3", "--matcher", "Bash").status, 0);
    assert.equal(home(dir, "install-hook", title, "--python", PYTHON, "--events", EVENTS).status, 0);
    assert.deepEqual(home(dir, "list-hooks").out.hooks.sort(), ["push-guard.py", "session-title.py"]);
    assert.deepEqual(home(dir, "remove-hook", "session-title.py").out, { removed_hooks: 2, deleted_file: true });
    assert.deepEqual(home(dir, "list-hooks").out, { hooks: ["push-guard.py"] });
    assert.deepEqual(settings(dir).hooks.SessionStart, []);
    assert.equal(settings(dir).hooks.PreToolUse.length, 1);
  });
});

test("install-hook refuses both or neither of --matcher and --events, and writes nothing", { skip }, () => {
  withHome((dir) => {
    const file = hookFile(dir, "session-title.py");
    const both = home(dir, "install-hook", file, "--python", PYTHON, "--matcher", "Bash", "--events", "SessionStart");
    assert.equal(both.status, 1);
    assert.match(both.out.error, /exactly one of --matcher or --events/);
    const neither = home(dir, "install-hook", file, "--python", "/usr/bin/python3");
    assert.equal(neither.status, 1);
    assert.match(neither.out.error, /exactly one of --matcher or --events/);
    const empty = home(dir, "install-hook", file, "--python", "/usr/bin/python3", "--events", "SessionStart,,");
    assert.equal(empty.status, 1);
    assert.match(empty.out.error, /Not a list of event names/);
    assert.equal(existsSync(join(dir, ".claude", "hooks", "session-title.py")), false);
    assert.equal(existsSync(settingsPath(dir)), false);
  });
});

test("a per-project mod turns off and back on in the repo's personal settings only", { skip }, () => {
  withHome((dir) => {
    const repo = join(dir, "repo");
    const local = join(repo, ".claude", "settings.local.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(local, JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } }));
    const shared = { enabledPlugins: { "tasks@inline": false } };
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify(shared));
    const off = home(dir, "project-mod", repo, "ci-watch", "off");
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(off.out, { settings: local, mod: "ci-watch", on: false, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(local, "utf8")),
      { permissions: { allow: ["Bash(npm test:*)"] }, enabledPlugins: { "ci-watch@inline": false } });
    assert.ok(!existsSync(local + ".bak"));
    assert.ok(!existsSync(settingsPath(dir)));
    // The shared file's switch counts too.
    assert.deepEqual(home(dir, "project-mods", repo).out, { off: ["ci-watch", "tasks"] });
    assert.equal(home(dir, "project-mod", repo, "ci-watch", "on").out.changed, true);
    assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), { permissions: { allow: ["Bash(npm test:*)"] } });
    assert.deepEqual(home(dir, "project-mods", repo).out, { off: ["tasks"] });
  });
});

test("turning a mod on outranks the shared file's off with a personal on", { skip }, () => {
  withHome((dir) => {
    const repo = join(dir, "repo");
    const local = join(repo, ".claude", "settings.local.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const shared = { enabledPlugins: { "tasks@inline": false } };
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify(shared));
    assert.deepEqual(home(dir, "project-mod", repo, "tasks", "on").out,
      { settings: local, mod: "tasks", on: true, changed: true });
    assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), { enabledPlugins: { "tasks@inline": true } });
    assert.deepEqual(home(dir, "project-mods", repo).out, { off: [] });
    // Asked again, it keeps that personal on.
    assert.equal(home(dir, "project-mod", repo, "tasks", "on").out.changed, false);
    assert.deepEqual(home(dir, "project-mods", repo).out, { off: [] });
  });
});

test("a computer-wide mod cannot be turned off for one project", { skip }, () => {
  withHome((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const refused = home(dir, "project-mod", repo, "shared-pc", "off");
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.out.error, /shared-pc is not a per-project mod/);
    assert.ok(!existsSync(join(repo, ".claude")));
    // A mistyped repo folder is refused, never read as "nothing is off".
    const missing = home(dir, "project-mods", join(dir, "no-such-repo"));
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.out.error, /Not a folder/);
  });
});

test("install-hook records each copy it writes, so the helper's follow can tell an edited one", { skip }, () => {
  withHome((dir) => {
    const file = hookFile(dir, "push-guard.py", "print('guard')\r\n");
    assert.equal(home(dir, "install-hook", file, "--python", python, "--matcher", "Bash").status, 0);
    const recorded = () => JSON.parse(readFileSync(join(dir, ".bindwright", "hooks.json"), "utf8")).files;
    const written = readFileSync(join(dir, ".claude", "hooks", "push-guard.py"));
    assert.equal(recorded()["push-guard.py"], createHash("sha256").update(written).digest("hex"));
    // A reinstall replaces the hook's whole set, so a module the new copy dropped is no longer recorded.
    const modules = join(dirname(file), "push_guard");
    mkdirSync(modules);
    writeFileSync(join(modules, "a.py"), "a\n");
    writeFileSync(join(modules, "b.py"), "b\n");
    assert.equal(home(dir, "install-hook", file, "--python", python, "--matcher", "Bash").status, 0);
    rmSync(join(modules, "b.py"));
    assert.equal(home(dir, "install-hook", file, "--python", python, "--matcher", "Bash").status, 0);
    assert.deepEqual(Object.keys(recorded()).sort(), ["push-guard.py", "push_guard/a.py"]);
    assert.equal(home(dir, "remove-hook", "push-guard.py").status, 0);
    assert.deepEqual(recorded(), {}, "a removed hook is forgotten");
  });
});

const HELPER_VERSION = "9.9.9";
const HELPER_FILE = `bindwright-${HELPER_VERSION}-py3-none-any.whl`;
const HELPER_URL = `https://github.com/starfoxcom/bindwright/releases/download/v${HELPER_VERSION}/${HELPER_FILE}`;

// A plugin folder whose helper.json pins the Python helper with `python` as its entry.
function pluginWithPin(dir, python) {
  const folder = join(dir, "plugin");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "helper.json"), JSON.stringify({ version: HELPER_VERSION, python }));
  return folder;
}

const pinEntry = (url = HELPER_URL) => ({ file: HELPER_FILE, url, sha256: "0".repeat(64) });

test("a helper install waits while a fresh install lock from another session is held", { skip }, () => {
  withHome((dir) => {
    const lock = join(dir, ".bindwright", "helper", "follow.lock");
    mkdirSync(join(dir, ".bindwright", "helper"), { recursive: true });
    writeFileSync(lock, "");
    const r = home(dir, "helper-install", pluginWithPin(dir, pinEntry()));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out, { busy: true });
    assert.ok(existsSync(lock), "the other session's lock stays in place");
  });
});

test("a helper pin that names another host is refused, and no install lock is left behind", { skip }, () => {
  withHome((dir) => {
    const elsewhere = "https://example.com/releases/" + HELPER_FILE;
    const r = home(dir, "helper-install", pluginWithPin(dir, pinEntry(elsewhere)));
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(r.out, { error: "the plugin's helper pin is missing or names an unexpected file" });
    assert.ok(!existsSync(join(dir, ".bindwright", "helper", "follow.lock")));
  });
});

test("a stale install lock is taken over, and a download that fails reports an error, not busy", { skip }, () => {
  withHome((dir) => {
    const helperHome = join(dir, ".bindwright", "helper");
    const lock = join(helperHome, "follow.lock");
    mkdirSync(helperHome, { recursive: true });
    writeFileSync(lock, "");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, tenMinutesAgo, tenMinutesAgo);
    // A proxy nothing listens on refuses the connection at once, so the download fails without the network.
    const deadProxy = { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" };
    const r = homeWithEnv(deadProxy, dir, "helper-install", pluginWithPin(dir, pinEntry()));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(typeof r.out.error, "string");
    assert.equal(r.out.busy, undefined);
    assert.ok(!existsSync(lock), "the taken-over lock is released after the failed attempt");
  });
});

test("a malformed proxy setting ends in an error answer and frees the lock", { skip }, () => {
  withHome((dir) => {
    const badProxy = { HTTPS_PROXY: "http://proxy:abc", https_proxy: "http://proxy:abc" };
    const r = homeWithEnv(badProxy, dir, "helper-install", pluginWithPin(dir, pinEntry()));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(typeof r.out.error, "string");
    assert.ok(!existsSync(join(dir, ".bindwright", "helper", "follow.lock")));
  });
});

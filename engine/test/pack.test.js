// The packed plugin (tools/pack_plugin.py) holds only what the plugin directory
// accepts, and the helper package carries everything setup runs: its engine,
// run from the helper alone, binds what the repo's engine binds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "../model.js";
import { encodeSetupCode } from "../setupcode.js";
import { python } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(engine, "..");
function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const needsPython = { skip: !python && "needs Python 3.8+" };

test("the helper binds what the repo's engine binds, and the plugin ships no code", needsPython, () => {
  const root = mkdtempSync(join(tmpdir(), "bw-pack-"));
  try {
    const out = join(root, "bindwright");
    const packed = run(python, [join(repo, "tools", "pack_plugin.py"), "--out", out]);
    assert.equal(packed.status, 0, packed.stderr);
    const version = readFileSync(join(repo, "VERSION"), "utf8").trim().replace(/^v/, "");
    const manifest = JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.version, version);
    assert.ok(existsSync(join(out, "skills", "setup", "SKILL.md")));
    assert.ok(!existsSync(join(out, "engine")) && !existsSync(join(out, "hooks")));
    const checked = run(python, [join(repo, "tools", "directory_check.py"), out]);
    assert.equal(checked.status, 0, checked.stdout);

    const helper = join(root, "helper");
    const built = run(python, [join(repo, "tools", "pack_plugin.py"), "--helper-out", helper]);
    assert.equal(built.status, 0, built.stderr);
    const pkg = JSON.parse(readFileSync(join(helper, "package.json"), "utf8"));
    assert.equal(pkg.version, version);
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.scripts, undefined);
    assert.ok(existsSync(join(helper, "hooks", "counts.mjs")));
    assert.ok(existsSync(join(helper, "workflows", "review-trial.js")));
    assert.ok(pkg.files.includes("workflows"));

    // Every path a skill names, in the plugin or the helper, is in that pack.
    for (const name of readdirSync(join(out, "skills"))) {
      const text = readFileSync(join(out, "skills", name, "SKILL.md"), "utf8");
      for (const [, base, rel] of text.matchAll(/(\$\{CLAUDE_PLUGIN_ROOT\}|<helper>)\/([\w./-]*\w)/g)) {
        if (rel.includes("<")) continue;
        const folder = base === "<helper>" ? helper : out;
        assert.ok(existsSync(join(folder, rel)), `${name} names ${base}/${rel}, which the pack lacks`);
      }
    }

    const team = defaults({ team: true, client: true });
    // Every template family: pre-commit, architecture, the research hook and the home guards.
    team.advanced = {
      ...team.advanced, precommit: "husky", architecture: "hexagonal", codeResearch: "findwright", hookLocation: "home",
    };
    for (const answers of [defaults(), team]) {
      const args = ["--code", encodeSetupCode(answers), "--year", "2026"];
      const expected = run(process.execPath, [join(engine, "cli.js"), ...args]);
      assert.equal(expected.status, 0, expected.stderr);
      const js = run(process.execPath, [join(helper, "engine", "cli.js"), ...args]);
      const py = run(python, ["-I", join(helper, "engine", "bind.py"), ...args]);
      assert.equal(js.stdout, expected.stdout, js.stderr);
      assert.equal(py.stdout, expected.stdout, py.stderr);
    }

    // A second pack replaces the first; a folder that is not a pack is left alone.
    assert.equal(run(python, [join(repo, "tools", "pack_plugin.py"), "--out", out]).status, 0);
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "keep.txt"), "mine");
    const refused = run(python, [join(repo, "tools", "pack_plugin.py"), "--out", other]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refusing to replace/);
    assert.equal(readFileSync(join(other, "keep.txt"), "utf8"), "mine");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Packed paths with edits git has not recorded: the zip (built from git) and
// the folder pack (from the working tree) would then differ on purpose.
const PACKED = ["plugin", "helper", "engine", "_core", "VERSION", "CHANGELOG.md", "LICENSE", "tools"];
const dirty = run("git", ["-C", repo, "status", "--porcelain", "--", ...PACKED]).stdout.trim() !== "";

test("the release zip has the same bytes on every build and the folder pack's files", {
  skip: (!python && "needs Python 3.8+") || (dirty && "packed files have uncommitted edits"),
}, () => {
  const root = mkdtempSync(join(tmpdir(), "bw-zip-"));
  try {
    const zip = (name) => {
      const out = run(python, [join(repo, "tools", "pack_plugin.py"), "--zip", join(root, name)]);
      assert.equal(out.status, 0, out.stderr);
      return readFileSync(join(root, name));
    };
    assert.ok(zip("a.zip").equals(zip("b.zip")), "two builds, one set of bytes");
    const list = "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))";
    const names = run(python, ["-c", list, join(root, "a.zip")]).stdout.trim().split(/\r?\n/);
    assert.equal(run(python, [join(repo, "tools", "pack_plugin.py"), "--out", join(root, "dir")]).status, 0);
    const walk = run(python, ["-c", "import os, sys; r = sys.argv[1]; print('\\n'.join(sorted("
      + "os.path.relpath(os.path.join(d, f), r).replace(os.sep, '/') for d, _, fs in os.walk(r) for f in fs)))",
    join(root, "dir")]).stdout.trim().split(/\r?\n/);
    assert.deepEqual(names, walk.filter((p) => p !== ".bindwright-pack.txt"));

    // --marketplace creates its folder and pins the zip just built.
    const file = join(root, "new", ".claude-plugin", "marketplace.json");
    const wrote = run(python, [join(repo, "tools", "pack_plugin.py"), "--marketplace", file]);
    assert.equal(wrote.status, 0, wrote.stderr);
    const sha = createHash("sha256").update(zip("c.zip")).digest("hex");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).plugins[0].source.sha256, sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the marketplace file lists the release zip by version and SHA-256", needsPython, () => {
  const script = "import sys; sys.path.insert(0, sys.argv[1]); import pack_plugin as p; "
    + "print(p.marketplace({'version': '2.0.0', 'description': 'd'}, 'ab' * 32), end='')";
  const out = run(python, ["-I", "-c", script, join(repo, "tools")]);
  assert.equal(out.status, 0, out.stderr);
  const market = JSON.parse(out.stdout);
  assert.equal(market.name, "bindwright");
  assert.deepEqual(market.plugins, [{
    name: "bindwright",
    description: "d",
    version: "2.0.0",
    source: {
      source: "archive",
      url: "https://github.com/starfoxcom/bindwright/releases/download/v2.0.0/bindwright-2.0.0.zip",
      sha256: "ab".repeat(32),
    },
  }]);
});

// npm's own script, run with this Node: where Node installers put it on Windows and elsewhere.
const npmCli = [
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((p) => existsSync(p));

// Each helper file the release attaches, the way setup installs it, and the engine it then runs.
const HELPER_KINDS = [
  ["node", "--tgz", (file, target) => [process.execPath, [npmCli, "install", "--prefix", target, "--no-save",
    "--ignore-scripts", "--no-audit", "--no-fund", "--offline", file]],
  (target, args) => [process.execPath, [join(target, "node_modules", "bindwright", "engine", "cli.js"), ...args]]],
  ["python", "--wheel", (file, target) => [python, ["-m", "pip", "install", "--quiet", "--no-deps", "--no-index",
    "--target", target, file]],
  (target, args) => [python, ["-I", join(target, "bindwright", "engine", "bind.py"), ...args]]],
];

test("each helper file has the same bytes on every build, matches the plugin's pin, installs and binds", {
  skip: (!python && "needs Python 3.8+") || (!npmCli && "needs npm")
    || (dirty && "packed files have uncommitted edits"),
}, () => {
  const root = mkdtempSync(join(tmpdir(), "bw-helper-"));
  try {
    const zip = join(root, "plugin.zip");
    assert.equal(run(python, [join(repo, "tools", "pack_plugin.py"), "--zip", zip]).status, 0);
    const read = "import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read('helper.json').decode())";
    const pins = JSON.parse(run(python, ["-c", read, zip]).stdout);
    const args = ["--code", encodeSetupCode(defaults()), "--year", "2026"];
    const expected = run(process.execPath, [join(engine, "cli.js"), ...args]);
    for (const [kind, flag, install, bind] of HELPER_KINDS) {
      const build = (name) => {
        const out = run(python, [join(repo, "tools", "pack_plugin.py"), flag, join(root, kind, name)]);
        assert.equal(out.status, 0, out.stderr);
        return out.stdout.trim().replace(/^Built /, "");
      };
      const file = build("a");
      assert.ok(readFileSync(file).equals(readFileSync(build("b"))), `${kind}: two builds, one set of bytes`);
      assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), pins[kind].sha256, kind);
      assert.ok(pins[kind].url.endsWith(`/v${pins.version}/${pins[kind].file}`), kind);
      const target = join(root, kind, "target");
      const installed = run(...install(file, target));
      assert.equal(installed.status, 0, installed.stderr);
      const bound = run(...bind(target, args));
      assert.equal(bound.stdout, expected.stdout, `${kind}: ${bound.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Each row breaks one rule the directory applies to organizations that are not Verified.
const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");
const DIRECTORY_CASES = [
  ["a script", "skills/x/run.mjs", "export {};\n", /not Markdown, text, JSON, YAML/],
  ["a shebang in a text file", "notes.txt", "#!/bin/sh\necho hi\n", /starts with #!/],
  ["a NUL byte", "notes.md", Buffer.from("a\0b"), /NUL byte/],
  ["text that is not UTF-8", "notes.md", Buffer.from([0xff, 0xfe, 0x41]), /not UTF-8/],
  ["a package manager's file", "package.json", "{}\n", /package manager/],
  ["declared hooks", "hooks/hooks.json", "{}\n", /declares hooks/],
  ["allowed-tools in a skill", "skills/x/SKILL.md", "---\nname: x\nallowed-tools: Bash\n---\n", /allowed-tools/],
  ["hooks in the manifest", ".claude-plugin/plugin.json", '{"name":"x","hooks":{}}\n', /declares hooks/],
  ["an image that is not one", "icon.png", "not a png", /not the image/],
  ["a text file with no extension", "VERSION", "1.0.0\n", /not Markdown, text, JSON, YAML/],
  ["a credential word beside a URL", "skills/x/run.md", "Pass the token to https://example.com/api\n",
    /run\.md:1 names token beside a network call/],
  ["an environment variable beside a download", "README.md", "a\n`curl -o \"$HOME/f\" <url>`\n",
    /README\.md:2 names \$HOME beside a network call/],
  ["a frontmatter value YAML reads as a map", "skills/x/SKILL.md", "---\nname: x\ndescription: a: b\n---\n",
    /frontmatter lines outside/],
  ["a value after a second space", "skills/x/SKILL.md", "---\nname: x\nargument-hint:  [a | b]\n---\n",
    /frontmatter lines outside/],
  ["a frontmatter opener with a trailing space", "skills/x/SKILL.md", "--- \nname: x\nallowed-tools: Bash\n---\n",
    /more than an exact --- line/],
  ["a key hidden after a lone CR", "skills/x/SKILL.md", "---\nname: x\ndescription: a\rallowed-tools:\tBash\n---\n",
    /frontmatter lines outside/],
];

test("the directory check refuses each kind of file the directory refuses", needsPython, () => {
  const root = mkdtempSync(join(tmpdir(), "bw-dircheck-"));
  try {
    const check = (name, files) => {
      const dir = join(root, name.replace(/\W+/g, "-"));
      for (const [rel, data] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), data);
      }
      return run(python, [join(repo, "tools", "directory_check.py"), dir]);
    };
    const clean = {
      "skills/x/SKILL.md":
        "---\nname: x\ndescription: d\ndisable-model-invocation: true\nargument-hint: \"[a | b]\"\n---\n# x\n",
      ".claude-plugin/plugin.json": '{"name":"x"}\n', ".claude-plugin/icon.png": PNG, LICENSE: "MIT\n",
    };
    assert.equal(check("clean", clean).status, 0);
    for (const [name, rel, data, message] of DIRECTORY_CASES) {
      const out = check(name, { ...clean, [rel]: data });
      assert.equal(out.status, 1, name);
      assert.match(out.stdout, message, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

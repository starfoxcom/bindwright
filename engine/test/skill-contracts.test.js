// engine/home.py skill-contracts builds a project's skill-check contracts and settles them in
// skill-contracts.json. Every case runs on a throwaway home folder, never the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function homeWithEnv(env, dir, ...args) {
  const options = { encoding: "utf8", env: { ...process.env, ...env } };
  const r = spawnSync(python, [join(engine, "home.py"), ...args, "--home", dir], options);
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}

const contracts = (dir, root, ...args) =>
  homeWithEnv({ CLAUDE_CONFIG_DIR: "" }, dir, "skill-contracts", root, ...args);
const contractsFile = (dir) => join(dir, ".claude", "skill-contracts.json");
const readContracts = (dir) => JSON.parse(readFileSync(contractsFile(dir), "utf8"));

// The project folder is named in mixed case, so the key is checked lowercase.
function project(dir, advanced) {
  const root = join(dir, "Demo-Project");
  mkdirSync(join(root, ".bindwright"), { recursive: true });
  writeFileSync(join(root, ".bindwright", "project.json"), JSON.stringify({ advanced }));
  return root;
}

function writeContracts(dir, data) {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(contractsFile(dir), JSON.stringify(data));
}

test("a missing key reports missing, with only the steps its answers keep", { skip }, () => {
  withHome((dir) => {
    const root = project(dir, { tracker: "github" });
    const r = contracts(dir, root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.key, "demo-project");
    assert.equal(r.out.case, "missing");
    assert.equal(r.out.current, null);
    const names = r.out.steps["start-session"].map((step) => step.step);
    const has = (text) => names.some((name) => name.includes(text));
    assert.ok(!has("hand-off file"), "tracker=file step is gone");
    assert.ok(has("open items"), "tracker=github step is kept");
    assert.ok(has("how far behind"), "codeHost!=local step is kept");
    for (const steps of Object.values(r.out.steps)) {
      assert.ok(steps.every((step) => !("when" in step)), "when is left out of every kept step");
    }
    assert.equal(existsSync(contractsFile(dir)), false, "a check writes nothing");
  });
});

test("accept then check reports same, and keeps an unrelated key", { skip }, () => {
  withHome((dir) => {
    const root = project(dir, { tracker: "github" });
    writeContracts(dir, { other: { "close-session": [] } });
    const accepted = contracts(dir, root, "accept");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.out.changed, true);
    assert.equal(contracts(dir, root).out.case, "same");
    assert.deepEqual(readContracts(dir).other, { "close-session": [] });
  });
});

test("decline on a missing key stores only _offered, then checks as declined", { skip }, () => {
  withHome((dir) => {
    const root = project(dir, { tracker: "github" });
    const declined = contracts(dir, root, "decline");
    assert.equal(declined.status, 0, declined.stderr);
    assert.equal(declined.out.case, "missing");
    assert.deepEqual(Object.keys(readContracts(dir)["demo-project"]), ["_offered"]);
    assert.equal(contracts(dir, root).out.case, "declined");
  });
});

test("decline keeps own steps; accept then replaces them and drops _offered", { skip }, () => {
  withHome((dir) => {
    const root = project(dir, { tracker: "github" });
    const own = [{ step: "mine", match: "x", tools: ["Bash"] }];
    writeContracts(dir, { "demo-project": { "start-session": own } });
    assert.equal(contracts(dir, root).out.case, "differs");
    contracts(dir, root, "decline");
    const afterDecline = readContracts(dir)["demo-project"];
    assert.deepEqual(afterDecline["start-session"], own);
    assert.equal(contracts(dir, root).out.case, "declined");
    const accepted = contracts(dir, root, "accept");
    assert.equal(accepted.out.case, "declined");
    const afterAccept = readContracts(dir)["demo-project"];
    assert.equal("_offered" in afterAccept, false);
    assert.equal(contracts(dir, root).out.case, "same");
  });
});

test("CLAUDE_CONFIG_DIR routes the contracts file; the home folder keeps none", { skip }, () => {
  withHome((dir) => {
    withHome((configDir) => {
      const root = project(dir, { tracker: "file" });
      const env = { CLAUDE_CONFIG_DIR: configDir };
      const r = homeWithEnv(env, dir, "skill-contracts", root, "accept");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.file, join(configDir, "skill-contracts.json"));
      assert.equal(existsSync(join(configDir, "skill-contracts.json")), true);
      assert.equal(existsSync(contractsFile(dir)), false);
    });
  });
});

test("answers read as the engine binds them: a removed tool counts as custom", { skip }, () => {
  withHome((dir) => {
    const root = project(dir, { tracker: "github", codeResearch: "serena" });
    const r = contracts(dir, root);
    assert.equal(r.status, 0, r.stderr);
    const names = Object.values(r.out.steps).flat().map((step) => step.step);
    assert.ok(names.some((name) => name.includes("code-research count")), "the count step is kept");
  });
});

test("a non-JSON contracts file and a bad argument are refused, file kept", { skip }, () => {
  withHome((dir) => {
    const root = project(dir, { tracker: "github" });
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(contractsFile(dir), "{not json");
    const broken = contracts(dir, root, "accept");
    assert.equal(broken.status, 1);
    assert.match(broken.out.error, /skill-contracts\.json/);
    const badArgument = contracts(dir, root, "maybe");
    assert.equal(badArgument.status, 1);
    assert.equal(readFileSync(contractsFile(dir), "utf8"), "{not json");
  });
});

// The recording harness: the scenario data is valid, the hashes ignore line
// endings, the replay shapes a session's events, and every recording still
// matches the demo and the bind it was made from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../model.js";
import {
  exercisedFor, outcomeFrom, replayFrom, scenarioAnswers, staleParts, textHash,
} from "../../tools/recording.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const recordings = join(repo, "recordings");
const read = (file) => JSON.parse(readFileSync(join(recordings, file), "utf8"));
const data = read("scenarios.json");
const planted = read("planted.json").planted;
const VARIANTS = ["without", "with"];

test("scenario ids are unique and every exercised problem is planted", () => {
  const ids = data.scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "scenario ids are unique");
  const plantedIds = new Set(planted.map((p) => p.id));
  for (const scenario of data.scenarios) {
    for (const id of scenario.exercises) {
      assert.ok(plantedIds.has(id), `${scenario.id} exercises ${id}, which is not planted`);
    }
  }
});

test("the scenario answers pass the engine's own validation", () => {
  assert.doesNotThrow(() => validate(scenarioAnswers(data.answers)));
});

test("textHash ignores line endings and entry order", () => {
  assert.equal(textHash([["a", "x\r\ny"]]), textHash([["a", "x\ny"]]));
  assert.equal(
    textHash([["a", "1"], ["b", "2"]]),
    textHash([["b", "2"], ["a", "1"]]),
  );
  assert.notEqual(textHash([["a", "1"]]), textHash([["a", "2"]]));
});

const WHO = {
  repo: "C:\\Users\\tester\\AppData\\Local\\Temp\\rec-abc",
  home: "C:\\Users\\tester",
  user: "tester",
};
const SPLIT_PATH = "C:\\Users\\tester\\AppData\\Local\\Temp\\rec-abc\\src\\split.ts";
const LONG_READ = "word ".repeat(400);
const LONG_EDIT = "old text. ".repeat(80);

const FIXTURE = [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [
    { type: "text", text: "Reading the splitter." },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: SPLIT_PATH } },
  ] } },
  { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: LONG_READ, is_error: false },
  ] } },
  { type: "assistant", message: { content: [
    { type: "tool_use", id: "t2", name: "Bash", input: { command: "node --test" } },
  ] } },
  { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t2", is_error: true,
      content: [{ type: "text", text: "not ok 1 - mail tester@example.com" }] },
  ] } },
  { type: "assistant", message: { content: [
    { type: "tool_use", id: "t3", name: "Edit", input: {
      file_path: SPLIT_PATH, old_string: `${LONG_EDIT}cut off here`, new_string: "new text.",
    } },
  ] } },
  { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t3", is_error: false,
      content: "The file has been updated." },
  ] } },
  { type: "assistant", message: { content: [
    { type: "tool_use", id: "t4", name: "Grep", input: { pattern: "roundAll" } },
  ] } },
  { type: "result", subtype: "success", is_error: false, num_turns: 4,
    total_cost_usd: 0.42, duration_ms: 12345 },
];

const EXPECTED_TURNS = [
  { type: "say", text: "Reading the splitter." },
  { type: "tool", name: "Read", input: "splitbill\\src\\split.ts",
    output: `${"word ".repeat(300)}…`, isError: false },
  { type: "tool", name: "Bash", input: "node --test",
    output: "not ok 1 - mail <email>", isError: true },
  { type: "tool", name: "Edit",
    input: `splitbill\\src\\split.ts\n- ${LONG_EDIT}\n+ new text.`,
    output: "The file has been updated.", isError: false },
  { type: "tool", name: "Grep", input: "roundAll", output: "", isError: false },
];

test("replayFrom shapes a session's events into turns, scrubbed and cut", () => {
  assert.deepEqual(replayFrom(FIXTURE, WHO), EXPECTED_TURNS);
});

test("outcomeFrom maps the result event and leaves absent fields null", () => {
  assert.deepEqual(outcomeFrom(FIXTURE.at(-1)), {
    costUsd: 0.42, turns: 4, durationMs: 12345, isError: false,
  });
  assert.deepEqual(outcomeFrom(undefined), {
    costUsd: null, turns: null, durationMs: null, isError: null,
  });
});

test("every recording matches the demo and the bind it was made from", async () => {
  for (const scenario of data.scenarios) {
    for (const variant of VARIANTS) {
      const file = join(recordings, scenario.id, `${variant}.json`);
      if (!existsSync(file)) continue;
      const recording = JSON.parse(readFileSync(file, "utf8"));
      const current = await exercisedFor(repo, scenario, variant, data.answers);
      assert.deepEqual(staleParts(recording, current), [],
        `re-record: node tools/record.mjs ${scenario.id} ${variant}`);
    }
  }
});

test("a changed input is reported by its key", async () => {
  const [scenario] = data.scenarios;
  const current = await exercisedFor(repo, scenario, "with", data.answers);
  const recording = { exercised: { ...current, demo: "0".repeat(64) } };
  assert.deepEqual(staleParts(recording, current), ["demo"]);
});

// The tool-version check (helper/hooks/tool-versions.mjs): version parsing and
// comparison, what a finding says about a release gap, and that a source which
// cannot be read leaves its tool out. No network: every source is a fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_URL, GH_URL, GIT_URL, NODE_INDEX_URL, NODE_SCHEDULE_URL, UV_URL,
  checkTools, compareVersions, fixFor, nodeFinding, normalize, releaseFinding, sayFor,
} from "../../helper/hooks/tool-versions.mjs";

const TODAY = "2026-11-13";

const normalizeRows = [
  ["a leading v is dropped", "v2.56.1", "2.56.1"],
  ["a plain version is kept", "24.22.2", "24.22.2"],
  ["Git for Windows' form keeps its build number", "2.56.1.windows.3", "2.56.1.3"],
  ["a release candidate suffix is dropped", "2.104.0-rc1", "2.104.0"],
  ["text with no leading digits is null", "next", null],
  ["a missing value is null", undefined, null],
];

for (const [name, text, want] of normalizeRows) {
  test(`normalize: ${name}`, () => {
    assert.equal(normalize(text), want);
  });
}

const compareRows = [
  ["equal versions compare as 0", "2.56.1", "2.56.1", 0],
  ["a missing part counts as 0", "2.56.1", "2.56.1.0", 0],
  ["an extra part makes a version newer", "2.56.1.3", "2.56.1", 1],
  ["numbers compare as numbers, not text", "2.9.0", "2.10.0", -1],
  ["a leading v is ignored", "v2.0.0", "2.0.0", 0],
  ["a release candidate equals its release", "2.104.0-rc1", "2.104.0", 0],
  ["Git's build numbers compare as numbers", "2.56.1.windows.3", "2.56.1.windows.10", -1],
];

for (const [name, a, b, want] of compareRows) {
  test(`compareVersions: ${name}`, () => {
    assert.equal(compareVersions(a, b), want);
  });
}

// Checks only the fields a row names.
function assertFields(actual, want) {
  for (const [key, value] of Object.entries(want)) assert.deepEqual(actual[key], value, key);
}

const index = [
  { version: "v24.22.3", lts: "Krypton", security: true },
  { version: "v24.22.2", lts: "Krypton", security: false },
  { version: "v24.21.0", lts: "Krypton", security: false },
  { version: "v20.19.5", lts: "Iron", security: false },
  { version: "v25.1.0", lts: false, security: false },
];
const calm = index.map((entry) => ({ ...entry, security: false }));
const schedule = {
  v20: { end: "2026-04-30" },
  v24: { end: "2028-04-30" },
};

const nodeRows = [
  ["a security patch behind", { have: "24.22.2", index, today: TODAY },
    { latest: "24.22.3", security: true, ended: false, ok: false, newestLts: "24.22.3" }],
  ["a plain patch behind", { have: "24.22.2", index: calm, today: TODAY },
    { latest: "24.22.3", security: false, ok: false }],
  ["the newest release is current", { have: "24.22.3", index, today: TODAY },
    { latest: "24.22.3", security: false, ended: false, ok: true }],
  ["the last day of a line has not ended", { have: "24.22.2", index, today: "2028-04-30" },
    { ended: false }],
  ["a line past its end date has ended", { have: "20.19.5", index, today: TODAY },
    { ended: true, ok: false, lineEnds: "2026-04-30", newestLts: "24.22.3" }],
  ["a line missing from the schedule has no end date", { have: "25.1.0", index, today: TODAY },
    { lineEnds: null, ended: false, ok: true }],
  ["a line missing from the index is current as it stands", { have: "26.0.0", index, today: TODAY },
    { latest: "26.0.0", security: false, lineEnds: null, ok: true }],
];

for (const [name, input, want] of nodeRows) {
  test(`nodeFinding: ${name}`, () => {
    assertFields(nodeFinding({ ...input, schedule }), want);
  });
}

const releaseRows = [
  ["behind with a CVE in the notes",
    { have: "2.56.1", tag: "v2.56.2", notes: "Fixes CVE-2026-12345." },
    { latest: "2.56.2", security: true, ok: false }],
  ["behind without a security note", { have: "2.56.1", tag: "v2.56.2", notes: "Bug fixes." },
    { latest: "2.56.2", security: false, ok: false }],
  ["behind with no notes", { have: "2.56.1", tag: "v2.56.2", notes: null },
    { security: false, ok: false }],
  ["current", { have: "2.56.2", tag: "v2.56.2", notes: null },
    { latest: "2.56.2", security: false, ok: true }],
  ["Git's Windows build is current", { have: "2.56.1.3", tag: "v2.56.1.windows.3", notes: null },
    { latest: "2.56.1.3", ok: true }],
];

for (const [name, input, want] of releaseRows) {
  test(`releaseFinding: ${name}`, () => {
    assertFields(releaseFinding({ id: "gh", ...input }), want);
  });
}

test("sayFor: a behind release that fixes security says so", () => {
  const finding = releaseFinding({
    id: "gh", have: "2.80.0", tag: "v2.80.1", notes: "Security fix.",
  });
  assert.equal(sayFor(finding), "GitHub CLI 2.80.0 is behind 2.80.1, which fixes security issues.");
});

test("fixFor: Node on Windows upgrades with winget", () => {
  assert.equal(fixFor("node", "win32"), "winget upgrade --id OpenJS.NodeJS.LTS");
});

// Answers from `replies` by URL, rejects a URL whose reply is an Error, and
// records every URL it was asked for.
function fakeFetch(replies) {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    const reply = replies[url];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetchJson, calls };
}

const replies = {
  [NODE_INDEX_URL]: index,
  [NODE_SCHEDULE_URL]: schedule,
  [GIT_URL]: { tag_name: "v2.56.1.windows.3", body: null },
  [GH_URL]: { tag_name: "v2.80.1", body: "Security fix." },
  [UV_URL]: { tag_name: "0.9.0", body: null },
  [CLAUDE_URL]: { version: "2.1.0" },
};

const versions = { node: "24.22.2", git: "2.56.1.3", gh: "2.80.0", uv: "0.8.0", claude: "2.1.0" };

const checkRows = [
  ["a rejected source leaves its tool out",
    { ...replies, [GIT_URL]: new Error("ENOTFOUND") }, ["git"]],
  ["a reply without its field leaves its tool out", { ...replies, [GH_URL]: {} }, ["gh"]],
];

for (const [name, table, unreachable] of checkRows) {
  test(`checkTools: ${name}`, async () => {
    const { fetchJson } = fakeFetch(table);
    const result = await checkTools({ platform: "win32", today: TODAY, versions, fetchJson });
    assert.deepEqual(result.unreachable, unreachable);
    const everyTool = ["node", "git", "gh", "uv", "claude"];
    const reported = everyTool.filter((id) => !unreachable.includes(id));
    assert.deepEqual(result.tools.map((tool) => tool.id), reported);
  });
}

test("checkTools: tools come back in order, each with its sentence and fix", async () => {
  const { fetchJson } = fakeFetch(replies);
  const result = await checkTools({ platform: "win32", today: TODAY, versions, fetchJson });
  assert.deepEqual(result.tools.map((tool) => tool.id), ["node", "git", "gh", "uv", "claude"]);
  for (const tool of result.tools) {
    assert.equal(typeof tool.say, "string", tool.id);
    assert.equal(typeof tool.fix, "string", tool.id);
  }
});

const fetchRows = [
  ["Node asks only its two sources", { node: "24.22.2" }, [NODE_INDEX_URL, NODE_SCHEDULE_URL]],
  ["gh and claude ask only their own", { gh: "2.80.0", claude: "2.1.0" }, [GH_URL, CLAUDE_URL]],
  ["no tools found asks nothing", {}, []],
];

for (const [name, found, urls] of fetchRows) {
  test(`checkTools fetches only what is needed: ${name}`, async () => {
    const { fetchJson, calls } = fakeFetch(replies);
    await checkTools({ platform: "win32", today: TODAY, versions: found, fetchJson });
    assert.deepEqual([...calls].sort(), [...urls].sort());
  });
}

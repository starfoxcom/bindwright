// Bindwright's tool-version check: whether this computer's Node, Git (Windows
// only), GitHub CLI, uv and Claude Code CLI are behind their releases, and which
// of the gaps are security releases. /bindwright:doctor and /bindwright:setup run
// it and show each finding with its upgrade command. Run as a script, it prints
// one JSON line. The only network use is a plain GET of each release source; a
// source that cannot be read leaves its tool out of the findings. Node 18+.

import { execFileSync, execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";
export const NODE_SCHEDULE_URL =
  "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
export const GIT_URL = "https://api.github.com/repos/git-for-windows/git/releases/latest";
export const GH_URL = "https://api.github.com/repos/cli/cli/releases/latest";
export const UV_URL = "https://api.github.com/repos/astral-sh/uv/releases/latest";
export const CLAUDE_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

// A release note that names a CVE or a security fix marks its release as one.
const SECURITY_NOTE = /\bCVE-\d{4}-\d{4,}\b|\bsecurity\b/i;
const NAMES = { node: "Node", git: "Git", gh: "GitHub CLI", uv: "uv", claude: "Claude Code CLI" };

const NODE_OTHER_FIX = "Install the newest release of your line from "
  + "https://nodejs.org/en/download, or update Node with the package manager that installed it.";
const GH_OTHER_FIX = "Update gh with the package manager that installed it: "
  + "https://github.com/cli/cli#installation";
const GH_FIX = { win32: "winget upgrade --id GitHub.cli", darwin: "brew upgrade gh" };
const UV_FIX = {
  win32: "uv self update (or winget upgrade --id astral-sh.uv when it was installed that way)",
  darwin: "uv self update (or brew upgrade uv when it was installed that way)",
};

const majorOf = (version) => version.split(".")[0];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The plain dotted version at the start of `text`, or null when no digits lead it.
// Git for Windows tags its builds "2.56.1.windows.3", which is read as "2.56.1.3".
export function normalize(text) {
  const match = /^v?(\d+(?:\.\d+)*)(?:\.windows\.(\d+))?/.exec(String(text).trim());
  if (!match) return null;
  return match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`;
}

// The numbers of a version. A missing or unreadable version counts as 0.
const numbersOf = (version) => (normalize(version) ?? "0").split(".").map(Number);

// -1, 0 or 1 by comparing two versions part by part; "2.56.1" equals "2.56.1.0".
export function compareVersions(a, b) {
  const x = numbersOf(a);
  const y = numbersOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// The highest of some plain dotted versions, or null when there are none.
function highest(versions) {
  let best = null;
  for (const version of versions) {
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

// The Node finding for `have` against nodejs.org's release index and the Release
// schedule. A line's schedule `end` is the last day it gets security fixes.
export function nodeFinding({ have, index, schedule, today }) {
  const major = majorOf(have);
  const releases = index
    .map((entry) => ({
      version: normalize(entry.version),
      lts: Boolean(entry.lts),
      security: entry.security === true,
    }))
    .filter((release) => release.version !== null);
  const line = releases.filter((release) => majorOf(release.version) === major);
  const latest = highest(line.map((release) => release.version)) ?? have;
  const security = line.some(
    (release) => release.security && compareVersions(release.version, have) > 0,
  );
  const lineEnds = schedule?.[`v${major}`]?.end ?? null;
  // Dates are YYYY-MM-DD, so comparing the text compares the days.
  const ended = lineEnds !== null && today > lineEnds;
  const withLts = releases.filter((release) => release.lts);
  const newestLts = highest(withLts.map((release) => release.version));
  const ok = compareVersions(latest, have) <= 0 && !ended;
  return { id: "node", have, latest, security, lineEnds, ended, newestLts, ok };
}

// The finding for a tool whose latest release is a GitHub release (`tag` is its
// tag_name, `notes` its body) or an npm version (`tag` is the version, `notes` null).
export function releaseFinding({ id, have, tag, notes }) {
  const latest = normalize(tag);
  return {
    id,
    have,
    latest,
    security: SECURITY_NOTE.test(notes ?? ""),
    ok: compareVersions(have, latest) >= 0,
  };
}

// The command, or the instruction, that upgrades tool `id` on `platform`.
export function fixFor(id, platform) {
  switch (id) {
    case "node":
      return platform === "win32" ? "winget upgrade --id OpenJS.NodeJS.LTS" : NODE_OTHER_FIX;
    case "git":
      return "winget upgrade --id Git.Git";
    case "gh":
      return GH_FIX[platform] ?? GH_OTHER_FIX;
    case "uv":
      return UV_FIX[platform] ?? "uv self update";
    case "claude":
      return "claude update";
    default:
      throw new Error(`no upgrade command for ${id}`);
  }
}

function nodeSentence({ have, latest, security, lineEnds, ended, newestLts, ok }) {
  const major = majorOf(have);
  if (ended) {
    const target = newestLts ? `Node ${majorOf(newestLts)} (LTS)` : "the newest LTS line";
    return `Node ${major} stopped getting security fixes on ${lineEnds}; move to ${target}.`;
  }
  if (ok) return `Node ${have} is current on the ${major} line.`;
  if (security) return `Node ${have} is behind ${latest}, a security release on the ${major} line.`;
  return `Node ${have} is behind ${latest} on the ${major} line.`;
}

// One plain sentence about a finding, for the doctor and setup to show.
export function sayFor(finding) {
  if (finding.id === "node") return nodeSentence(finding);
  const name = NAMES[finding.id];
  if (finding.ok) return `${name} ${finding.have} is current.`;
  return `${name} ${finding.have} is behind ${finding.latest}`
    + (finding.security ? ", which fixes security issues." : ".");
}

// Runs `command` with fixed arguments and returns its stdout, or null on any error.
// On Windows a shell resolves npm's .cmd shims, which a plain spawn cannot start; it
// gets one string of fixed literals, since Node deprecates arguments beside a shell.
function runCommand(command, args, platform) {
  const options = {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  };
  try {
    return platform === "win32"
      ? execSync([command, ...args].join(" "), options)
      : execFileSync(command, args, options);
  } catch {
    return null;
  }
}

// Git is only checked on Windows, the one platform where this check upgrades it.
const PROBES = [
  { id: "git", command: "git", pattern: /git version (\S+)/, platform: "win32" },
  { id: "gh", command: "gh", pattern: /gh version (\S+)/ },
  { id: "uv", command: "uv", pattern: /uv (\S+)/ },
  { id: "claude", command: "claude", pattern: /^(\d+\.\d+\.\d+)/m },
];

function parseVersion(text, pattern) {
  const match = pattern.exec(text ?? "");
  return match ? normalize(match[1]) : null;
}

// The normalized version of each tool found here, and only those. Node comes from
// the running process; the other tools from their --version output.
export function localVersions({
  platform,
  run = (command, args) => runCommand(command, args, platform),
}) {
  const versions = { node: normalize(process.versions.node) };
  for (const probe of PROBES) {
    if (probe.platform && probe.platform !== platform) continue;
    const version = parseVersion(run(probe.command, ["--version"]), probe.pattern);
    if (version) versions[probe.id] = version;
  }
  return versions;
}

// Each tool's sources, and how their replies become a finding. A reply without the
// field the finding needs makes build return null, so the tool counts as unreachable.
function releaseSource(id, url) {
  return {
    urls: [url],
    build: ([release], have) => {
      if (!normalize(release?.tag_name)) return null;
      return releaseFinding({ id, have, tag: release.tag_name, notes: release.body });
    },
  };
}

const TOOLS = {
  node: {
    urls: [NODE_INDEX_URL, NODE_SCHEDULE_URL],
    build: ([index, schedule], have, today) => {
      if (!Array.isArray(index) || !isObject(schedule)) return null;
      return nodeFinding({ have, index, schedule, today });
    },
  },
  git: releaseSource("git", GIT_URL),
  gh: releaseSource("gh", GH_URL),
  uv: releaseSource("uv", UV_URL),
  claude: {
    urls: [CLAUDE_URL],
    build: ([pkg], have) => {
      if (!normalize(pkg?.version)) return null;
      return releaseFinding({ id: "claude", have, tag: pkg.version, notes: null });
    },
  },
};

// The finding for one tool, or null when its sources cannot be read.
async function findingFor(id, have, { today, fetchJson }) {
  const tool = TOOLS[id];
  try {
    const replies = await Promise.all(tool.urls.map((url) => fetchJson(url)));
    return tool.build(replies, have, today);
  } catch {
    return null;
  }
}

const withText = (finding, platform) => ({
  ...finding,
  say: sayFor(finding),
  fix: fixFor(finding.id, platform),
});

// The findings for the tools in `versions`, in the order node, git, gh, uv, claude.
// Only the sources those tools need are fetched. A tool that cannot be checked is
// listed in `unreachable` and gets no finding.
export async function checkTools({ platform, today, versions, fetchJson }) {
  const ids = Object.keys(TOOLS).filter((id) => versions[id]);
  const found = await Promise.all(ids.map(async (id) => {
    const finding = await findingFor(id, versions[id], { today, fetchJson });
    return { id, finding };
  }));
  return {
    tools: found.filter(({ finding }) => finding).map(({ finding }) => withText(finding, platform)),
    unreachable: found.filter(({ finding }) => !finding).map(({ id }) => id),
  };
}

// A GET of one release source, with a timeout; any non-2xx status is an error.
async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "bindwright-tool-check" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const platform = process.platform;
  const result = await checkTools({
    platform,
    today: new Date().toLocaleDateString("en-CA"),
    versions: localVersions({ platform }),
    fetchJson,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Run as a script, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {});
}

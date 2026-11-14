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
export const GIT_URL = "https://api.github.com/repos/git-for-windows/git/releases?per_page=30";
export const GH_URL = "https://api.github.com/repos/cli/cli/releases?per_page=30";
export const UV_URL = "https://api.github.com/repos/astral-sh/uv/releases?per_page=30";
// The stable tag, not latest: stable-channel installs sit about a week behind latest
// on purpose, and `claude update` brings any CLI below stable up on either channel.
export const CLAUDE_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/stable";

// A release note that names an advisory (a CVE or GitHub's GHSA id) or a security fix.
// A bare mention of security or of a vulnerability (a SECURITY.md link, a policy, a
// report form, a scanner feature, "no security impact") does not count.
const SECURITY_NOTE = new RegExp([
  String.raw`\bCVE-\d{4}-\d{4,}\b`,
  String.raw`\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b`,
  String.raw`\bsecurity (?:fix|fixes|release|update|updates|advisory|issue|issues)\b`,
].join("|"), "i");
const NAMES = { node: "Node", git: "Git", gh: "GitHub CLI", uv: "uv", claude: "Claude Code CLI" };

const NO_UPGRADE = "No upgrade needed.";
const NODE_FROM = "from https://nodejs.org/en/download, or with the tool that installed Node "
  + "(winget, nvm, fnm, Volta).";
const NODE_LTS_COMMAND = "winget upgrade --id OpenJS.NodeJS.LTS";
const GIT_FIX = "Update Git for Windows from https://gitforwindows.org.";
const GH_FIX = "Update gh with the tool that installed it: "
  + "https://github.com/cli/cli#installation";
const GH_COMMANDS = { win32: "winget upgrade --id GitHub.cli", darwin: "brew upgrade gh" };
const UV_FIX = "Run uv self update when uv came from its standalone installer; "
  + "otherwise update it the way it was installed (winget, brew, pip or pipx).";
const CLAUDE_FIX = "Run claude update, or update the CLI with the package manager that "
  + "installed it.";

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

// A schedule end that is not a YYYY-MM-DD date would compare wrongly against today,
// so it counts as no end date.
const endDateOf = (end) => (
  typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null
);

// Where a Node user on the ended `major` line should move: the newest release on the
// newest LTS line when that line is above `major`, else the newest release overall,
// so the target never points to a lower major.
function moveTargetFor(major, newestLts, releases) {
  const ltsMajor = newestLts === null ? null : majorOf(newestLts);
  const onLtsAbove = ltsMajor !== null && Number(ltsMajor) > Number(major);
  const onLtsLine = (release) => majorOf(release.version) === ltsMajor;
  const candidates = onLtsAbove ? releases.filter(onLtsLine) : releases;
  return highest(candidates.map((release) => release.version));
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
  const lineEnds = endDateOf(schedule?.[`v${major}`]?.end);
  // Dates are YYYY-MM-DD, so comparing the text compares the days.
  const ended = lineEnds !== null && today > lineEnds;
  const withLts = releases.filter((release) => release.lts);
  const newestLts = highest(withLts.map((release) => release.version));
  const moveTo = moveTargetFor(major, newestLts, releases);
  const ok = compareVersions(latest, have) <= 0 && !ended;
  return { id: "node", have, latest, security, lineEnds, ended, newestLts, moveTo, ok };
}

// The finding for a release-based tool. `releases` lists its usable releases as
// { tag, notes }. The latest is the highest tag; a security release is one newer
// than `have` whose notes say so.
export function releaseFinding({ id, have, releases }) {
  const latest = highest(releases.map((release) => normalize(release.tag)));
  const security = releases.some(
    (release) => compareVersions(release.tag, have) > 0 && SECURITY_NOTE.test(release.notes ?? ""),
  );
  return { id, have, latest, security, ok: compareVersions(have, latest) >= 0 };
}

function nodeFix(finding, platform) {
  if (finding.ended) {
    const target = finding.moveTo ? `Node ${finding.moveTo}` : "the newest Node";
    return { fix: `Install ${target} ${NODE_FROM}`, command: null };
  }
  const onLtsLine = finding.newestLts !== null
    && majorOf(finding.have) === majorOf(finding.newestLts);
  const command = platform === "win32" && onLtsLine ? NODE_LTS_COMMAND : null;
  return { fix: `Install Node ${finding.latest} ${NODE_FROM}`, command };
}

const FIX_BY_TOOL = {
  node: nodeFix,
  git: () => ({ fix: GIT_FIX, command: "winget upgrade --id Git.Git" }),
  gh: (_finding, platform) => ({ fix: GH_FIX, command: GH_COMMANDS[platform] ?? null }),
  uv: () => ({ fix: UV_FIX, command: null }),
  claude: () => ({ fix: CLAUDE_FIX, command: "claude update" }),
};

// The fix text and the shell command that applies it, the command null when none is
// certain to apply. A current tool needs no upgrade.
export function fixFor(finding, platform) {
  if (finding.ok) return { fix: NO_UPGRADE, command: null };
  return FIX_BY_TOOL[finding.id](finding, platform);
}

function nodeSentence({ have, latest, security, lineEnds, ended, moveTo, ok }) {
  const major = majorOf(have);
  if (ended) {
    const target = moveTo ? `Node ${majorOf(moveTo)}` : "a newer line";
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

// A GitHub release that can be the latest: not a draft, not a prerelease, and a tag
// that reads as a version.
const isUsableRelease = (release) => isObject(release)
  && release.draft !== true
  && release.prerelease !== true
  && normalize(release.tag_name) !== null;

// Each tool's sources and how their replies become a finding. A reply that is not a
// list of releases, or holds no usable one, makes build return null, so the tool
// counts as unreachable.
function releaseSource(id, url) {
  return {
    urls: [url],
    build: ([releases], have) => {
      const usable = Array.isArray(releases) ? releases.filter(isUsableRelease) : [];
      if (usable.length === 0) return null;
      const list = usable.map((release) => ({ tag: release.tag_name, notes: release.body }));
      return releaseFinding({ id, have, releases: list });
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
      return releaseFinding({ id: "claude", have, releases: [{ tag: pkg.version, notes: null }] });
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
  ...fixFor(finding, platform),
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

// Prints the one JSON line the doctor reads: the check's result, or the error that
// stopped it.
async function main() {
  const platform = process.platform;
  let result;
  try {
    result = await checkTools({
      platform,
      today: new Date().toLocaleDateString("en-CA"),
      versions: localVersions({ platform }),
      fetchJson,
    });
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Run as a script, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {});
}

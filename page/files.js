// The files a setup writes, rendered in the browser by the same engine
// /bindwright:setup runs, so the preview is never a hand-made copy.
import { bind } from "../engine/bind.js";

const repo = new URL("../", import.meta.url);
const cache = new Map();
// A failed read leaves the cache, so the next try fetches it again.
const fetchText = (path) => {
  if (!cache.has(path)) {
    cache.set(path, fetch(new URL(path, repo)).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return r.text();
    }).catch((err) => {
      cache.delete(path);
      throw err;
    }));
  }
  return cache.get(path);
};

// The files bind reads outside the core-files.json list.
const EXTRA_READS = [
  "_core/project-template/precommit/precommit-profiles.json",
  ...["MIT", "Apache-2.0", "BSD-3-Clause", "Proprietary"].map((l) => `_core/licenses/${l}.txt`),
  ...["CLAUDE.md.additions", "memory-template/MEMORY.md", "hooks/push-guard.py",
    "hooks/no-ai-attribution.py", "hooks/code-research-profiles.json",
    "hooks/code-research-first.py.template"].map((p) => `_core/global-template/${p}`),
];

// Six requests at a time: what a browser opens to one host, and few enough
// that a small server does not refuse the rest.
const PARALLEL = 6;

// Fetches every template ahead of bind, which reads them one after another
// and on a slow network would pay a full round trip per file.
async function prefetch() {
  const coreFiles = JSON.parse(await fetchText("engine/core-files.json"));
  const queue = [...coreFiles.map((p) => `_core/project-template/${p}`), ...EXTRA_READS, "VERSION"];
  const worker = async () => {
    while (queue.length) await fetchText(queue.shift());
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return coreFiles;
}

// Starts with the page, so the files are in by the time the questions are answered.
let ready = prefetch();
ready.catch(() => {}); // repoFiles retries a failed prefetch

const STAGING = ".bindwright/incoming/";
// Engine bookkeeping and the ~/.claude extras, which setup offers apart.
const HIDDEN = [".bindwright/pristine.json", ".bindwright/global/"];

// [[path, text], ...] as the files land in the repo, sorted folders first.
export async function repoFiles(answers) {
  const coreFiles = await ready.catch(() => (ready = prefetch()));
  const version = (await fetchText("VERSION")).trim().replace(/^v+/, "");
  const files = await bind(answers, { readFile: fetchText, coreFiles, year: new Date().getFullYear(), version });
  const out = [];
  for (const [dest, text] of files) {
    if (HIDDEN.some((h) => dest.startsWith(h))) continue;
    out.push([dest.startsWith(STAGING) ? dest.slice(STAGING.length) : dest, text]);
  }
  return out.sort(([a], [b]) => byFolder(a, b));
}

// Folders before files at each level, then by name.
export function byFolder(a, b) {
  const [x, y] = [a.split("/"), b.split("/")];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [xDir, yDir] = [i < x.length - 1, i < y.length - 1];
    if (xDir !== yDir) return xDir ? -1 : 1;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

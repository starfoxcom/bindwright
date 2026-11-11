// The meaning layer of the index: each text file split into overlapping windows
// of lines, each window stored as an int8 vector of the static code model.

import { dot, ensureModel, loadModel, packVector } from "./embed.mjs";

let loading = null;

/**
 * The meaning model with the index's vectors brought up to date: `{ ready }`, or
 * `{ ready: null, note }` while it downloads or when it cannot load, so a search
 * still answers by words alone. Set FINDWRIGHT_MEANING=off to skip it.
 */
export async function meaningModel(db) {
  if (process.env.FINDWRIGHT_MEANING === "off") return { ready: null };
  loading ??= ensureModel().then(loadModel);
  try {
    const model = await loading;
    embedMissing(db, model);
    return { ready: model };
  } catch (error) {
    loading = null;
    return { ready: null, note: `(meaning search is off: ${error.message}; ranked by words only)` };
  }
}

const WINDOW_LINES = 30;
const STEP_LINES = 20;

/** Embeds every indexed text file that has no vectors yet; returns how many it embedded. */
export function embedMissing(db, model) {
  const todo = db.prepare(
    "SELECT b.path, b.text FROM body b JOIN files f ON f.path = b.path WHERE b.path NOT IN (SELECT path FROM embedded)",
  ).all();
  const insert = db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)");
  const mark = db.prepare("INSERT OR IGNORE INTO embedded VALUES (?)");
  db.exec("BEGIN");
  try {
    for (const { path, text } of todo) {
      const lines = text.split(/\r?\n/);
      for (let start = 0; start < lines.length; start += STEP_LINES) {
        const end = Math.min(lines.length, start + WINDOW_LINES);
        const vector = model.encode(`${path}\n${lines.slice(start, end).join("\n")}`);
        if (vector) insert.run(path, start + 1, end, packVector(vector));
        if (end === lines.length) break;
      }
      mark.run(path);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return todo.length;
}

/** Each file's best window similarity to `query`, as a Map of path to [0, 1]. */
export function meaningScores(db, model, query, keep = () => true) {
  const vector = model.encode(query);
  const best = new Map();
  if (!vector) return best;
  for (const { path, vec } of db.prepare("SELECT path, vec FROM chunks").iterate()) {
    if (!keep(path)) continue;
    const s = dot(vector, vec);
    if (s > (best.get(path) ?? 0)) best.set(path, s);
  }
  return best;
}

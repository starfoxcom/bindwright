// The counter's storage on Cloudflare D1 (SQLite). Tables are in
// counter/schema.sql. No row holds an IP address, a repo name or a user.

import { FIELDS, dayOf } from "./rules.js";

/**
 * Wraps a D1 database binding with the two calls the handler needs. The
 * handler takes any object with the same methods, so tests pass an
 * in-memory one.
 */
export class D1Store {
  /** @param {D1Database} database the `DB` binding from wrangler.jsonc */
  constructor(database) {
    this._database = database;
  }

  /**
   * Adds one checked send to its project's totals and answers `"added"`,
   * `"too-soon"` (the project sent less than `gapInMilliseconds` ago) or
   * `"day-full"` (a new project past `maxNewPerDay` today). The limits are
   * conditions of the writes themselves, run as one D1 batch, which is a
   * transaction: two sends arriving together cannot both pass a check.
   */
  async addSend({ send, country, timeInMilliseconds, gapInMilliseconds, maxNewPerDay }) {
    const day = dayOf(timeInMilliseconds);
    const counts = FIELDS.map((field) => send[field]);
    const [, , upsert] = await this._database.batch([
      this._database.prepare("DELETE FROM new_projects WHERE day < ?1").bind(day),
      this._database
        .prepare(
          `INSERT OR IGNORE INTO new_projects (day, id)
           SELECT ?1, ?2
           WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = ?2)
             AND (SELECT COUNT(*) FROM new_projects WHERE day = ?1) < ?3`,
        )
        .bind(day, send.project, maxNewPerDay),
      this._database
        .prepare(
          `INSERT INTO projects (id, kind, country, checked, caught, deep, merged, last_send)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
           WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)
              OR EXISTS (SELECT 1 FROM new_projects WHERE day = ?9 AND id = ?1)
           ON CONFLICT (id) DO UPDATE SET
             kind = excluded.kind,
             country = excluded.country,
             checked = checked + excluded.checked,
             caught = caught + excluded.caught,
             deep = deep + excluded.deep,
             merged = merged + excluded.merged,
             last_send = excluded.last_send
           WHERE projects.last_send <= excluded.last_send - ?10`,
        )
        .bind(send.project, send.kind, country, ...counts, timeInMilliseconds, day, gapInMilliseconds),
    ]);
    if (upsert.meta.changes > 0) return "added";
    const known = await this._database
      .prepare("SELECT 1 FROM projects WHERE id = ?1")
      .bind(send.project)
      .first();
    return known === null ? "day-full" : "too-soon";
  }

  /** The overall sums, projects per country and the top projects by `checked`. */
  async totals(topProjects) {
    const [sums, countries, top] = await this._database.batch([
      this._database.prepare(
        `SELECT COUNT(*) AS projects, COALESCE(SUM(checked), 0) AS checked,
                COALESCE(SUM(caught), 0) AS caught, COALESCE(SUM(deep), 0) AS deep,
                COALESCE(SUM(merged), 0) AS merged
         FROM projects`,
      ),
      this._database.prepare(
        "SELECT country, COUNT(*) AS projects FROM projects GROUP BY country ORDER BY projects DESC",
      ),
      this._database
        .prepare(
          `SELECT kind, checked, caught, deep, merged FROM projects
           ORDER BY checked DESC, merged DESC LIMIT ?1`,
        )
        .bind(topProjects),
    ]);
    return { ...sums.results[0], countries: countries.results, top: top.results };
  }
}

// The counter's storage on Cloudflare D1 (SQLite). Tables are in
// counter/schema.sql. No row holds an IP address, a repo name or a user.

import { FIELDS, dayOf } from "./rules.js";

/**
 * Wraps a D1 database binding with the four calls the handler needs.
 * The handler takes any object with the same methods, so tests pass an
 * in-memory one.
 */
export class D1Store {
  /** @param {D1Database} database the `DB` binding from wrangler.toml */
  constructor(database) {
    this._database = database;
  }

  /** The project's last accepted send time in milliseconds, or null when it is new. */
  async lastSendOf(projectId) {
    const row = await this._database
      .prepare("SELECT last_send FROM projects WHERE id = ?1")
      .bind(projectId)
      .first();
    return row === null ? null : row.last_send;
  }

  /** How many new projects were accepted on a UTC day (`YYYY-MM-DD`). */
  async newProjectsOn(day) {
    const row = await this._database
      .prepare("SELECT new_projects FROM days WHERE day = ?1")
      .bind(day)
      .first();
    return row === null ? 0 : row.new_projects;
  }

  /** Adds one checked send to its project's totals, creating the project when new. */
  async addSend({ send, country, timeInMilliseconds, isNew }) {
    const upsert = this._database
      .prepare(
        `INSERT INTO projects (id, kind, country, checked, caught, deep, merged, last_send)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind,
           country = excluded.country,
           checked = checked + excluded.checked,
           caught = caught + excluded.caught,
           deep = deep + excluded.deep,
           merged = merged + excluded.merged,
           last_send = excluded.last_send`,
      )
      .bind(send.project, send.kind, country, ...FIELDS.map((f) => send[f]), timeInMilliseconds);
    if (!isNew) {
      await upsert.run();
      return;
    }

    const countDay = this._database
      .prepare(
        `INSERT INTO days (day, new_projects) VALUES (?1, 1)
         ON CONFLICT (day) DO UPDATE SET new_projects = new_projects + 1`,
      )
      .bind(dayOf(timeInMilliseconds));
    await this._database.batch([upsert, countDay]);
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

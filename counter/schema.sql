-- Tables for the opt-in review counter (counter/src/store.js).
-- A project is a random id the plugin makes once per repo; nothing here
-- names a repo, a user or an IP address.

CREATE TABLE IF NOT EXISTS projects (
  id        TEXT PRIMARY KEY,  -- 32 lowercase hex characters, random
  kind      TEXT NOT NULL,     -- one of rules.js KINDS
  country   TEXT NOT NULL,     -- two-letter code Cloudflare derived from the last send, XX unknown
  checked   INTEGER NOT NULL DEFAULT 0,
  caught    INTEGER NOT NULL DEFAULT 0,
  deep      INTEGER NOT NULL DEFAULT 0,
  merged    INTEGER NOT NULL DEFAULT 0,
  last_send INTEGER NOT NULL   -- milliseconds since the epoch
);

CREATE INDEX IF NOT EXISTS projects_by_checked ON projects (checked DESC, merged DESC);

-- New projects accepted per UTC day, for the daily cap.
CREATE TABLE IF NOT EXISTS days (
  day          TEXT PRIMARY KEY,  -- YYYY-MM-DD
  new_projects INTEGER NOT NULL DEFAULT 0
);

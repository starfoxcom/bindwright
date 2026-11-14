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
  stalled   INTEGER NOT NULL DEFAULT 0,  -- PRs with STALL_ROUNDS or more red review rounds (rules.js)
  rounds    INTEGER NOT NULL DEFAULT 0,  -- red review rounds, summed over the checked PRs
  last_send INTEGER NOT NULL,  -- milliseconds since the epoch
  covered_to INTEGER NOT NULL  -- end of the newest counted window, milliseconds since the epoch
);

CREATE INDEX IF NOT EXISTS projects_by_checked ON projects (checked DESC, merged DESC);

-- The projects first accepted on the current UTC day, for the daily cap.
-- Earlier days are deleted on the next send.
CREATE TABLE IF NOT EXISTS new_projects (
  day TEXT NOT NULL,  -- YYYY-MM-DD
  id  TEXT NOT NULL,
  PRIMARY KEY (day, id)
);

-- The last GET /total answer, so a read costs one row. The first read after
-- rules.js TOTALS_MAX_AGE_IN_SECONDS claims the refresh by moving refreshed_at,
-- so one request per period recomputes; every other read gets this copy.
CREATE TABLE IF NOT EXISTS totals_copy (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  refreshed_at INTEGER NOT NULL,  -- milliseconds since the epoch, 0 before the first read
  body         TEXT NOT NULL      -- the answer as JSON
);

INSERT OR IGNORE INTO totals_copy (id, refreshed_at, body) VALUES (1, 0,
  '{"projects":0,"checked":0,"caught":0,"deep":0,"merged":0,"stalled":0,"rounds":0,"countries":[],"top":[]}');

-- Adds the outcome counts (rules.js OUTCOME_COUNTS) to a database made before them.
-- A database made from schema.sql already has these columns: run this only on an older one.
ALTER TABLE projects ADD COLUMN rebuilt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN rebuilt_caught INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN rebuilt_stalled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;

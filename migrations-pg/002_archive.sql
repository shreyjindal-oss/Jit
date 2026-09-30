-- Archive (soft-delete): hidden from the tool's lists but kept and restorable.
ALTER TABLE searches ADD COLUMN IF NOT EXISTS archived_at TEXT;
ALTER TABLE batches  ADD COLUMN IF NOT EXISTS archived_at TEXT;
ALTER TABLE alerts   ADD COLUMN IF NOT EXISTS archived_at TEXT;

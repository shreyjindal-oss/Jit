-- Archive (soft-delete): hidden from the tool's lists but kept in the database and restorable.
ALTER TABLE searches ADD COLUMN archived_at TEXT;
ALTER TABLE batches ADD COLUMN archived_at TEXT;
ALTER TABLE alerts ADD COLUMN archived_at TEXT;

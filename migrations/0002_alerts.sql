-- Listing alerts: re-run a saved set of search parameters on a schedule and email new listings.
CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  name            TEXT,
  email           TEXT NOT NULL,
  request_json    TEXT NOT NULL,           -- search parameters (location, beds, access, …)
  frequency_days  INTEGER NOT NULL,        -- 1 (daily) … 14 (fortnightly)
  start_date      TEXT NOT NULL,           -- YYYY-MM-DD
  end_date        TEXT NOT NULL,           -- YYYY-MM-DD, at most 30 days after start
  next_run_at     TEXT NOT NULL,           -- ISO timestamp
  last_run_at     TEXT,
  runs            INTEGER NOT NULL DEFAULT 0,
  emails_sent     INTEGER NOT NULL DEFAULT 0,
  last_new_count  INTEGER,
  last_error      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | stopped | ended
  stop_token      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_alerts_email ON alerts(email);

CREATE TABLE IF NOT EXISTS alert_seen (
  alert_id   TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  url_key    TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (alert_id, url_key)
);

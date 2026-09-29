-- JIT inventory sourcer — Postgres schema (Cloud Run / Cloud SQL).
-- Same tables and columns as the D1 migrations (migrations/0001, 0002) so the app code is shared.
-- Timestamps are ISO-8601 TEXT on purpose (identical behaviour on D1 and Postgres).
-- Applied automatically at server start (idempotent), or run by hand with psql.

CREATE TABLE IF NOT EXISTS searches (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'ui',     -- ui | batch | api | alert
  batch_id        TEXT,
  location        TEXT NOT NULL,
  outcode         TEXT,
  la_name         TEXT,
  bedrooms        DOUBLE PRECISION,
  bathrooms       DOUBLE PRECISION,
  check_in        TEXT,
  check_out       TEXT,
  accessibility   TEXT,
  client_account  TEXT,
  enquiry_ref     TEXT,
  listing_count   INTEGER,
  median_rent_pcm DOUBLE PRECISION,
  ons_pcm         DOUBLE PRECISION,
  duration_ms     INTEGER,
  request_json    TEXT NOT NULL,
  summary_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at);
CREATE INDEX IF NOT EXISTS idx_searches_outcode ON searches(outcode);
CREATE INDEX IF NOT EXISTS idx_searches_batch ON searches(batch_id);

CREATE TABLE IF NOT EXISTS listings (
  id             SERIAL PRIMARY KEY,
  search_id      TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  rank           INTEGER,
  portal         TEXT,
  url            TEXT,
  title          TEXT,
  address        TEXT,
  outcode        TEXT,
  bedrooms       DOUBLE PRECISION,
  bathrooms      DOUBLE PRECISION,
  rent_pcm       DOUBLE PRECISION,
  available_from TEXT,
  furnished      TEXT,
  floor          TEXT,
  access_fit     TEXT,
  access_json    TEXT,
  agent_name     TEXT,
  agent_phone    TEXT,
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  distance_miles DOUBLE PRECISION,
  score          DOUBLE PRECISION,
  flags_json     TEXT,
  images_json    TEXT,
  snippet        TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_id);
CREATE INDEX IF NOT EXISTS idx_listings_outcode ON listings(outcode);
CREATE INDEX IF NOT EXISTS idx_listings_url ON listings(url);

CREATE TABLE IF NOT EXISTS batches (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  filename   TEXT,
  total      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued'       -- queued | running | done
);
CREATE TABLE IF NOT EXISTS batch_rows (
  batch_id      TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  row_no        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  attempts      INTEGER NOT NULL DEFAULT 0,
  request_json  TEXT NOT NULL,
  search_id     TEXT,
  listing_count INTEGER,
  error         TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  PRIMARY KEY (batch_id, row_no)
);
CREATE INDEX IF NOT EXISTS idx_batch_rows_status ON batch_rows(status);

CREATE TABLE IF NOT EXISTS alerts (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  name           TEXT,
  email          TEXT NOT NULL,
  request_json   TEXT NOT NULL,
  frequency_days INTEGER NOT NULL,
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  next_run_at    TEXT NOT NULL,
  last_run_at    TEXT,
  runs           INTEGER NOT NULL DEFAULT 0,
  emails_sent    INTEGER NOT NULL DEFAULT 0,
  last_new_count INTEGER,
  last_error     TEXT,
  status         TEXT NOT NULL DEFAULT 'active',  -- active | stopped | ended
  stop_token     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_alerts_email ON alerts(email);
CREATE TABLE IF NOT EXISTS alert_seen (
  alert_id   TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  url_key    TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (alert_id, url_key)
);

-- Replaces Cloudflare KV (ONS rent data).
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

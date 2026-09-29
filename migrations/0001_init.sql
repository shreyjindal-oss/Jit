-- JIT inventory sourcer: saved searches, their listings, and bulk-upload batches.
CREATE TABLE IF NOT EXISTS searches (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'ui',     -- ui | batch | api
  batch_id      TEXT,
  location      TEXT NOT NULL,
  outcode       TEXT,
  la_name       TEXT,
  bedrooms      INTEGER,
  bathrooms     INTEGER,
  check_in      TEXT,
  check_out     TEXT,
  accessibility TEXT,
  client_account TEXT,
  enquiry_ref   TEXT,
  listing_count INTEGER,
  median_rent_pcm INTEGER,
  ons_pcm       INTEGER,
  duration_ms   INTEGER,
  request_json  TEXT NOT NULL,
  summary_json  TEXT                            -- economics, ons, sources, warnings (no listings)
);
CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at);
CREATE INDEX IF NOT EXISTS idx_searches_outcode ON searches(outcode);
CREATE INDEX IF NOT EXISTS idx_searches_batch ON searches(batch_id);

CREATE TABLE IF NOT EXISTS listings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id     TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  rank          INTEGER,
  portal        TEXT,
  url           TEXT,
  title         TEXT,
  address       TEXT,
  outcode       TEXT,
  bedrooms      INTEGER,
  bathrooms     INTEGER,
  rent_pcm      INTEGER,
  available_from TEXT,
  furnished     TEXT,
  floor         TEXT,
  access_fit    TEXT,
  access_json   TEXT,
  agent_name    TEXT,
  agent_phone   TEXT,
  lat REAL, lng REAL,
  distance_miles REAL,
  score         INTEGER,
  flags_json    TEXT,
  images_json   TEXT,
  snippet       TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_id);
CREATE INDEX IF NOT EXISTS idx_listings_outcode ON listings(outcode);
CREATE INDEX IF NOT EXISTS idx_listings_url ON listings(url);

CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  filename    TEXT,
  total       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'    -- queued | running | done
);
CREATE TABLE IF NOT EXISTS batch_rows (
  batch_id    TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  row_no      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  attempts    INTEGER NOT NULL DEFAULT 0,
  request_json TEXT NOT NULL,
  search_id   TEXT,
  listing_count INTEGER,
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  PRIMARY KEY (batch_id, row_no)
);
CREATE INDEX IF NOT EXISTS idx_batch_rows_status ON batch_rows(status);

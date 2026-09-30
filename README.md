# JIT Inventory Sourcer

For enquiries where we have the location but **no inventory**. Enter dates, location and bed/bath
config and get a ranked list of **rental listings from Rightmove, Zoopla, OnTheMarket and OpenRent**:
address, listing URL, rent, beds/baths, availability, furnished status, agent name and phone (or
landlord, for OpenRent). An official **ONS average rent** for the area is shown alongside. It also estimates lease cost
against the stay, so the acquisition manager can call, secure the lease and offer the unit to the
client account.

## Hosting

**Production runs on Google Cloud Run** (Node 22 container) with **Cloud SQL Postgres**. Cloud Scheduler runs the background jobs.
The plan is to merge it into the admin / Enquiry App service later, still on Cloud Run (see [Merging into the admin app](#merging-into-the-admin--enquiry-app)).

The app code in `src/` is platform-neutral: one `fetch(request, env)` handler. It runs in two places:

| | Cloud Run (production) | Cloudflare Worker (original trial) |
|---|---|---|
| Entry point | `server/main.ts` (Node HTTP server, bundled to `dist/server.mjs`) | `src/index.ts` via `wrangler` |
| Database | Cloud SQL Postgres (`migrations-pg/`, applied automatically at start) | D1 (`migrations/`) |
| ONS data store | `kv` table in Postgres | KV namespace `ONS_KV` |
| Every-minute job (alerts + bulk rows) | Cloud Scheduler → `POST /api/cron/tick` | Workers cron `* * * * *` |
| Monthly ONS refresh | Cloud Scheduler → `POST /api/cron/ons` (+ GitHub Action) | Workers cron + GitHub Action |
| Secrets | Secret Manager | `wrangler secret put` |

`server/pg-adapter.ts` gives Postgres the same small interface as D1/KV, so there's a single codebase and both paths are tested (`npm test`).

## Deploy to Cloud Run (PowerShell)

One-time setup. Replace `PROJECT` and the passwords with your own. The region is London (`europe-west2`).

```powershell
$P="PROJECT"; $R="europe-west2"; $SQL="$($P):$($R):jit-db"
gcloud config set project $P
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# 1) Database. Small instance, about £8–10/month. You can instead use a database on an existing Cloud SQL Postgres instance.
gcloud sql instances create jit-db --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro --region=$R --storage-size=10
gcloud sql databases create jit --instance=jit-db
gcloud sql users create jit --instance=jit-db --password="DB_PASSWORD"

# 2) Service account + secrets (values are trimmed by the app, so piping from PowerShell is fine)
gcloud iam service-accounts create jit-sourcer
$SA="jit-sourcer@$P.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" --role="roles/cloudsql.client"
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
"apify_api_…"         | gcloud secrets create APIFY_TOKEN      --data-file=-
"YOUR_ACCESS_CODE"    | gcloud secrets create ACCESS_TOKEN     --data-file=-
"SG.…"                | gcloud secrets create SENDGRID_API_KEY --data-file=-
"postgres://jit:DB_PASSWORD@/jit?host=/cloudsql/$SQL" | gcloud secrets create DATABASE_URL --data-file=-
# (URL-encode special characters in DB_PASSWORD, e.g. @ → %40)
```

Deploy. Run this again for every release:

```powershell
gcloud run deploy jit-inventory-sourcer --source . --region=$R --service-account=$SA `
  --allow-unauthenticated --add-cloudsql-instances=$SQL --env-vars-file=cloudrun.env.yaml `
  --set-secrets="APIFY_TOKEN=APIFY_TOKEN:latest,ACCESS_TOKEN=ACCESS_TOKEN:latest,SENDGRID_API_KEY=SENDGRID_API_KEY:latest,DATABASE_URL=DATABASE_URL:latest" `
  --timeout=600 --memory=512Mi --cpu=1 --min-instances=0 --max-instances=3 --concurrency=20
```

- `--allow-unauthenticated` is needed because the app does its own access-code check (see [Access & sharing](#access--sharing)). If your org policy blocks public services, put it behind IAP instead.
- After the first deploy, copy the service URL into `PUBLIC_URL` in `cloudrun.env.yaml` and deploy again. It's used for share links and the links in alert emails.
- The tables are created automatically at start-up. The migrations in `migrations-pg/` are idempotent.

Background jobs (one-time):

```powershell
$URL="https://jit-inventory-sourcer-….europe-west2.run.app"; $CODE="YOUR_ACCESS_CODE"
gcloud scheduler jobs create http jit-tick --location=$R --schedule="* * * * *" --time-zone="Etc/UTC" `
  --uri="$URL/api/cron/tick" --http-method=POST --headers="x-access-token=$CODE" --attempt-deadline=540s
gcloud scheduler jobs create http jit-ons --location=$R --schedule="0 6 25 * *" --time-zone="Etc/UTC" `
  --uri="$URL/api/cron/ons" --http-method=POST --headers="x-access-token=$CODE" --attempt-deadline=300s
```

- `jit-tick` runs every minute. It runs one due alert, or else one bulk-upload row. Idle ticks take milliseconds.
- Overlapping ticks are safe: alerts and bulk rows are claimed atomically, so nothing runs twice.
- For the ONS refresh, also point the GitHub Action at Cloud Run. Set the repo variable `JIT_WORKER_URL` to `$URL` (Settings → Secrets and variables → Actions → Variables). The Action is the reliable path if ONS blocks Google's IPs as well.

Rough running cost, before Apify credit: Cloud SQL about £8–10/month. Cloud Run and Scheduler come to about £0–2/month at this volume; Scheduler includes 3 free jobs per billing account.

### Moving over from Cloudflare (one-off)

1. Export the D1 data and import it into Postgres. Use `cloud-sql-proxy` to reach Cloud SQL from your laptop:
   ```powershell
   npx wrangler d1 export jit-inventory --remote --no-schema --output d1-data.sql
   cloud-sql-proxy $SQL --port 5432     # in a second window (install: cloud.google.com/sql/docs/postgres/sql-proxy)
   $env:DATABASE_URL="postgres://jit:DB_PASSWORD@127.0.0.1:5432/jit"; npx tsx scripts/import-d1.ts d1-data.sql
   ```
   This copies saved searches, listings, bulk uploads and alerts, including which listings each alert has already emailed. It's safe to re-run.
2. **Turn off the Worker's crons** so alerts don't run twice from two databases. Set `crons = []` in `wrangler.toml` and run `npx wrangler deploy`, or delete the Worker once you're happy.
3. Load ONS once: `curl.exe -X POST "$URL/api/cron/ons" -H "x-access-token: $CODE"`, or run the GitHub Action.
4. Share the new link (below) with the team.

### Local development

```powershell
npm install
docker run -d --name jit-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
$env:DATABASE_URL="postgres://postgres:dev@127.0.0.1:5432/postgres"; $env:APIFY_TOKEN="apify_api_…"; $env:ACCESS_TOKEN="dev"
npm run dev:node          # http://127.0.0.1:8080  (the same server as Cloud Run)
npm test                  # all offline: HTTP mocked, Postgres via in-process PGlite
npm run typecheck
```

Locally nothing calls the background jobs, so trigger them by hand: `curl.exe -X POST http://127.0.0.1:8080/api/cron/tick -H "x-access-token: dev"`.

### Cloudflare Worker (original trial, still works)

```powershell
npx wrangler dev                                          # http://127.0.0.1:8787, uses .dev.vars
npx wrangler d1 migrations apply jit-inventory --remote   # D1 tables (re-run after each new migration)
npx wrangler deploy                                       # = npm run deploy:cf
```

## Access & sharing

Everything is behind one access code (`ACCESS_TOKEN`). **To share the tool, send a link with the code built in.** The person just opens it; there's nothing to type.

- In the tool, click **Copy share link** (top right of the tabs). It copies `https://<service>/?token=CODE`.
- Opening that link signs the browser in for 180 days. It sets a secure cookie *and* saves the code in the browser, so it also works where cookies are blocked (e.g. inside an iframe). The code is then removed from the address bar.
- Alert emails include the same signed-in link ("Open the sourcer"). Alerts only go to `@thesqua.re` addresses.
- Embedding in the Enquiry App: use an iframe to `https://<service>/?token=CODE&embed=1` (header hidden). Server-to-server callers send an `x-access-token: CODE` header.
- To revoke everyone's access, change the `ACCESS_TOKEN` secret, redeploy, and update the two Scheduler jobs' header.

## Saved searches, bulk upload, photos, accessibility

- **Saved searches:** every search, whether from the UI, the API or a bulk upload, is saved with all its listings. Reopen them in the **Saved searches** tab (it doesn't re-run the search, so it costs nothing). Tables: `searches`, `listings`, `batches`, `batch_rows` (`migrations-pg/001_init.sql`; D1: `migrations/0001_init.sql`). `listings` keeps outcode, rent, floor, accessibility and portal per row, so you can build a postcode opportunity dashboard from it later.
- **Bulk upload:** the **Bulk upload** tab takes a CSV or XLSX, one enquiry per row. Get the template from `/api/template.csv`. Column names are flexible: `postcode`/`location`, `arrival`/`check_in`, `bed type`/`bedrooms`, and so on. Dates can be YYYY-MM-DD, DD/MM/YYYY or Excel dates.
  - Rows are queued and processed in the background by the every-minute cron (`BATCH_CONCURRENCY`, default 1 row per minute; a minute with a due alert skips the bulk row). Each finished row becomes a saved search.
  - Download a batch's results as a single CSV from `/api/batches/<id>.csv`.
- **Photos:** each listing shows its main photo. Click it to open the full gallery (up to 12 images, from the portals' own image servers) without leaving the tool.
- **Accessibility:** the options are Any, Ground floor, Step-free (ground floor or lift) and Wheelchair accessible. No portal has a reliable accessibility filter, so the tool reads the title, summary, description and key features for:
  - the floor: ground, lower ground, nth, top, or bungalow
  - lift, step-free or level access, wheelchair access, ramp, wet room or walk-in shower, adapted
  - Clear mismatches are dropped, e.g. a 3rd floor with no lift for step-free.
  - Listings that don't say either way are kept and flagged "access not stated — check".
  - When accessibility is requested, Rightmove and Zoopla detail pages are fetched to get the full description. That's slower, about 60–90s.
- **Cost guards:** `MAX_SEARCHES_PER_DAY` (default 100, UI and bulk combined). Past the limit, searches are refused and bulk rows wait until the next day. `MAX_BATCH_ROWS` (default 50 per sheet).

## Filters (multi-select)

On the Search form, bedrooms, property type, furnishing, accessibility and must-haves are **tick-boxes**, so you can pick several. The API takes arrays (`"bedrooms": [2,3]`, `"mustHave": ["parking","pets"]`). The old single values (`"bedrooms": 2`, `"furnished": "furnished"`, `"accessibility": "step_free"`) still work.

| Filter | Rightmove | Zoopla | OnTheMarket | OpenRent | Otherwise |
|---|---|---|---|---|---|
| Bedrooms (several) | range | range | range | range | exact bed count checked after |
| Min / max rent | ✓ | ✓ | ✓ | ✓ | |
| Property type (flat, house, bungalow) | ✓ | one type only | ✓ | flats or houses | detected from listing |
| Furnishing (furnished, part, unfurnished) | ✓ | — | — | one only | from listing ("flexible" matches any) |
| Min bathrooms | — | ✓ | — | ✓ | flagged |
| Min size (sq ft) | — | ✓ | — | — | checked when the size is given |
| Added to portal (24h/3/7/14 days) | ✓ | newest first | ✓ (to 7 days) | newest first | checked when the date is given |
| Accessibility (all selected) | — | — | — | — | read from listing text |
| Must have: parking, pets, garden, bills included | — | — | — | ✓ | read from listing text |
| Must have: balcony / terrace | — | — | — | — | read from listing text |

- A clear "no" in the listing, such as "no pets" or "no parking", drops it.
- A listing that doesn't say either way is kept and flagged "… not stated — check".
- Tick **Only listings that confirm them** to hide those as well.
- Accessibility or must-haves make Rightmove and Zoopla fetch detail pages, so the search takes about 60–90s.
- Bulk upload accepts the same fields; put several values in one cell separated by `;`.

## Alerts (email new listings)

The **Alerts** tab, or the "Set alert for these filters" button on the Search tab, saves the current search filters with an email address. The every-minute cron re-runs the search on schedule and emails **only the listings not sent before**, with photo, rent, floor/access, agent and link. The first email is what's available now. If nothing is new, no email is sent. Emails come from `ALERT_FROM_EMAIL` (`noreply@thesqua.re`) via SendGrid.

Rules that prevent misuse:

- Frequency: daily, every 2 or 3 days, weekly, or fortnightly (1–14 days).
- The window from start to end date is at most **30 days**. The start can't be in the past and must be within 30 days. Alerts end automatically.
- Recipients must be on `ALERT_EMAIL_DOMAINS` (`thesqua.re`).
- At most `MAX_ACTIVE_ALERTS` (20) active alerts in total, and `MAX_ALERTS_PER_EMAIL` (3) per recipient.
- Every alert run is a normal saved search (source `alert`) and counts toward `MAX_SEARCHES_PER_DAY`.
- Every email has a one-click **Stop this alert** link (`/alerts/stop?id=…&t=…`, protected by a per-alert token).

Scheduled runs go out around 07:00 UTC. The cron runs only one heavy job per minute (an alert or a bulk row), and Apify's "concurrent runs" 402 is retried automatically. Tables: `alerts`, `alert_seen`.

Cost: a daily alert over 30 days is 30 searches, about $10 of Apify credit. A weekly alert is about $1.50.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/search` | Run a search and save it. Returns `{ id, …results }` |
| GET | `/api/searches?q=&limit=` | Saved searches (filter by location, postcode, ref or client) |
| GET | `/api/searches/:id` | One saved search with listings and images |
| POST | `/api/batches` | Upload a sheet (multipart `file`, or raw body + `?filename=`) |
| GET | `/api/batches`, `/api/batches/:id`, `/api/batches/:id.csv` | Progress and results |
| POST | `/api/batches/run` | Process one bulk row now |
| POST | `/api/cron/tick`, `/api/cron/ons` | Background jobs (called by Cloud Scheduler; needs `x-access-token`) |
| POST | `/api/archive`, `/api/unarchive` | Archive / restore (soft delete): `{searches:[ids], batches:[ids], alerts:[ids]}` or `{allExcept:{searches:[ids]}}`. Archived items disappear from the lists but stay in the database. |
| POST | `/api/searches/:id/derive` | Save a copy keeping only some bed sizes: `{bedrooms:[4,5], enquiryRef}` |
| POST | `/api/batches/:id/cancel`, `/api/batches/:id/retry[?empty=1]` | Stop a bulk upload / re-queue failed (or empty) rows |
| GET | `/api/share-link` | Link with the access code built in (signed-in users only) |
| POST / GET | `/api/alerts` | Create (`{name, email, frequencyDays, startDate, endDate, search:{…}}`) / list alerts |
| POST | `/api/alerts/:id/run`, `/api/alerts/:id/stop` | Run now (emails anything new) / stop |
| GET | `/alerts/stop?id=&t=` | Public one-click stop (link in each email) |
| GET | `/api/template.csv`, `/api/health`, `/api/ons` | |

## Sources

| Source | What it gives | Notes |
|---|---|---|
| `apify`: Rightmove (`scrapesage~rightmove-scraper`) | Rentals only: rent pcm/pw, beds, baths, address, postcode, lat/lng, agent name and phone, date added | `APIFY_RM_DETAILS="true"` adds furnished status and let-available date, but runs about 3x slower |
| `apify`: Zoopla (`scrapesage~zoopla-scraper`) | Rentals only: rent, beds, baths, address, lat/lng, agent name and phone, available-from | |
| `apify`: OnTheMarket (`fatihtahta~onthemarket-scraper`) | Rentals: rent, beds, address, lat/lng, agent name and phone, fees/deposit | about 10s, about $0.002 per listing |
| `apify`: OpenRent (`vivid-softwares~openrent-property-scraper`) | Landlord-direct: rent, beds, baths, furnished, **minimum tenancy**, available-from, deposit, landlord name | about 6s, about $0.015 per listing (capped at 10: `APIFY_OPENRENT_MAX`). Contact is via OpenRent messaging |
| ONS Price Index of Private Rents | Official average monthly rent by local authority → region → country, for 1/2/3/4+ bed | Free. Refreshed monthly (25th, 06:00 UTC). `GET /api/ons` shows the loaded month |
| `propertydata` (optional) | Area rent benchmark and rent-to-rent list | Only runs if `PROPERTYDATA_KEY` is set |

Rightmove's terms of use prohibit scraping. It is enabled here for a low-volume trial.
Each search takes about 30–60s, because the portals run in parallel. It costs roughly $0.35 in Apify credit (OpenRent is capped at 10 listings, about $0.15). 30 results per portal is the default (`APIFY_MAX_RESULTS`). Drop a portal from `APIFY_PORTALS` to cut cost.

The ONS refresh streams the 19 MB workbook and stores about 25 KB (a `kv` row in Postgres, or Cloudflare KV). On Cloudflare it needs Workers Paid for the CPU time.

## Filtering and ranking

- **Rentals only.** Sale-priced items are dropped.
- **Bed count must match exactly.** Rent more than 15% over the max is dropped.
- **Kept to the area.** Anything more than twice the radius away (and at least 3 miles past it) is dropped.
- **Duplicates are merged.**
- **Score (0–100):** bed/bath match, rent vs max and benchmark, distance, agent contact present, availability date. OpenRent listings also score higher when the landlord's minimum tenancy fits the stay (flagged "tenancy fits stay").

## Economics

- Stay nights vs likely lease (`MIN_LEASE_MONTHS`, default 6), with a void-risk warning when the lease outlasts the stay.
- Lease cost and the break-even nightly rate.
- Margin, when you enter our sell rate.

## API

`POST /api/search`
```json
{ "location": "Canary Wharf, London", "checkIn": "2026-10-12", "checkOut": "2027-01-10",
  "bedrooms": 2, "bathrooms": 2, "furnished": "furnished", "maxRentPcm": 3500, "radiusMiles": 2,
  "sellRateNightly": 175, "setupCost": 1500, "clientAccount": "…", "enquiryRef": "ENQ-12345" }
```
`bedrooms`: 0 = studio up to 6. `GET /api/health` shows which keys are set.

## Layout

```
src/index.ts          routes, access code/cookie, share link, cron entry points (platform-neutral)
src/pipeline.ts       validate → geocode → sources → localise → dedupe/rank → economics
src/sources/apify.ts  Rightmove, Zoopla, OnTheMarket, OpenRent (rentals)
src/filters.ts        multi-select filters: parsing, feature/type detection, labels
src/alerts.ts         listing alerts: validation/limits, cron runs, new-listing diff, SendGrid email
src/db.ts, batch.ts   saved searches, bulk upload
src/ons.ts            ONS rent data: zip/xlsx stream parser, monthly refresh, area lookup
src/sources/propertydata.ts
src/geo.ts, parse.ts, economics.ts, ui.ts, types.ts
server/main.ts        Cloud Run: Node HTTP server, Postgres pool, migrations at start
server/pg-adapter.ts  Postgres behind the D1/KV interface (SQL dialect translation)
migrations-pg/        Postgres schema          migrations/   D1 schema (Cloudflare)
scripts/import-d1.ts  one-off D1 → Postgres copy
Dockerfile, cloudrun.env.yaml, wrangler.toml
test/                 smoke, apify, ons, access/batch, filters, db, alerts, pg (Postgres + import)
```

## Merging into the admin / Enquiry App

The target is to fold this into the admin / Enquiry App service and keep it on Cloud Run. The code is set up for that:

- **Handler:** `src/index.ts` exports a standard `fetch(Request, env)` handler with no framework. Mount it under a path in the admin service (e.g. `/jit/*`), or keep it as its own Cloud Run service behind the same domain / load balancer.
- **Database:** the tables are plain Postgres (`migrations-pg/001_init.sql`). They can move into the admin database, ideally under their own schema (`jit`). Point `DATABASE_URL` at it.
- **Auth:** the shared access code becomes the admin app's own login once merged. Replace `authorised()` in `src/index.ts` with the admin session check.
- **Jobs:** the two Cloud Scheduler jobs just call HTTP endpoints, so they carry over unchanged.

## Roadmap

- Phase 3: take the enquiry straight from the Enquiry App (and use its login instead of the access code).
- Candidates: shortlists and outreach status per listing; postcode opportunity board from `listings`.

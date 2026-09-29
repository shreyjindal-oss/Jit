# JIT Inventory Sourcer

For enquiries where we have the location but **no inventory**. Enter dates, location and bed/bath
config and get a ranked list of **rental listings from Rightmove, Zoopla, OnTheMarket and OpenRent**:
address, listing URL, rent, beds/baths, availability, furnished status, agent name and phone (or
landlord, for OpenRent). An official **ONS average rent** for the area is shown alongside. It also estimates lease cost
against the stay, so the acquisition manager can call, secure the lease and offer the unit to the
client account.

This is a Cloudflare Worker (TypeScript). It runs locally with `wrangler dev`, then deploys with
`wrangler deploy`.

## Run / deploy (PowerShell)

```powershell
npm install
copy .dev.vars.example .dev.vars; notepad .dev.vars   # APIFY_TOKEN (+ ACCESS_TOKEN)
npx wrangler dev                                       # http://127.0.0.1:8787
npm test                                               # offline test, all HTTP mocked

npx wrangler secret put APIFY_TOKEN
npx wrangler secret put ACCESS_TOKEN
npx wrangler kv namespace create ONS_KV --binding ONS_KV --update-config   # once, for ONS data
npx wrangler d1 create jit-inventory      # once: paste the printed [[d1_databases]] block into wrangler.toml (+ migrations_dir = "migrations")
npx wrangler d1 migrations apply jit-inventory --remote   # creates the tables (re-run after new migrations)
npx wrangler deploy
# load ONS data the first time (afterwards the monthly cron does it):
curl.exe -X POST "https://<worker>.workers.dev/api/ons/refresh" -H "x-access-token: YOUR_ACCESS_TOKEN"
```

**ONS monthly refresh:** ONS blocks downloads from Cloudflare, so the GitHub Action
`.github/workflows/ons-refresh.yml` does it instead. On the 25th of each month it downloads the
workbook and POSTs it to `/api/ons/upload`, and it skips the upload if that release is already
loaded. Set the repo secret `JIT_ACCESS_TOKEN`. To run it by hand: Actions → "ONS rents refresh" →
Run workflow. The Worker's own cron trigger also tries, and fails harmlessly while ONS blocks it.

**Access:** open `https://<worker>.workers.dev/?token=YOUR_ACCESS_TOKEN` once per device. The
token is saved as a 180-day secure cookie. API callers send an `x-access-token` header instead.

## Saved searches, bulk upload, photos, accessibility

- **Saved searches (D1):** every search, whether from the UI, the API or a bulk upload, is saved with all its listings. Reopen them in the **Saved searches** tab (it doesn't re-run the search, so it costs nothing). Tables: `searches`, `listings`, `batches`, `batch_rows` (`migrations/0001_init.sql`). `listings` keeps outcode, rent, floor, accessibility and portal per row, so you can build a postcode opportunity dashboard from it later.
- **Bulk upload:** the **Bulk upload** tab takes a CSV or XLSX, one enquiry per row. Get the template from `/api/template.csv`. Column names are flexible: `postcode`/`location`, `arrival`/`check_in`, `bed type`/`bedrooms`, and so on. Dates can be YYYY-MM-DD, DD/MM/YYYY or Excel dates.
  - Rows are queued and processed in the background by the every-minute cron (`BATCH_CONCURRENCY`, default 2 rows per minute). Each finished row becomes a saved search.
  - Download a batch's results as a single CSV from `/api/batches/<id>.csv`.
- **Photos:** each listing shows its main photo. Click it to open the full gallery (up to 12 images, from the portals' own image servers) without leaving the tool.
- **Accessibility:** the options are Any, Ground floor, Step-free (ground floor or lift) and Wheelchair accessible. No portal has a reliable accessibility filter, so the tool reads the title, summary, description and key features for:
  - the floor: ground, lower ground, nth, top, or bungalow
  - lift, step-free or level access, wheelchair access, ramp, wet room or walk-in shower, adapted
  - Clear mismatches are dropped, e.g. a 3rd floor with no lift for step-free.
  - Listings that don't say either way are kept and flagged "access not stated — check".
  - When accessibility is requested, Rightmove and Zoopla detail pages are fetched to get the full description. That's slower, about 60–90s.
- **Cost guards:** `MAX_SEARCHES_PER_DAY` (default 100, UI and bulk combined). Past the limit, searches are refused and bulk rows wait until the next day. `MAX_BATCH_ROWS` (default 50 per sheet).
- **Embedding in the Enquiry App:** use an iframe pointing at `https://<worker>/?token=YOUR_ACCESS_TOKEN&embed=1`. The header is hidden, and the login cookie is `SameSite=None; Partitioned` so it works inside an iframe. Server-to-server callers can `POST /api/search` with `x-access-token`.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/search` | Run a search and save it. Returns `{ id, …results }` |
| GET | `/api/searches?q=&limit=` | Saved searches (filter by location, postcode, ref or client) |
| GET | `/api/searches/:id` | One saved search with listings and images |
| POST | `/api/batches` | Upload a sheet (multipart `file`, or raw body + `?filename=`) |
| GET | `/api/batches`, `/api/batches/:id`, `/api/batches/:id.csv` | Progress and results |
| POST | `/api/batches/run` | Process one batch tick now (for local dev, where cron doesn't fire) |
| GET | `/api/template.csv`, `/api/health`, `/api/ons` | |

## Sources

| Source | What it gives | Notes |
|---|---|---|
| `apify`: Rightmove (`scrapesage~rightmove-scraper`) | Rentals only: rent pcm/pw, beds, baths, address, postcode, lat/lng, agent name and phone, date added | `APIFY_RM_DETAILS="true"` adds furnished status and let-available date, but runs about 3x slower |
| `apify`: Zoopla (`scrapesage~zoopla-scraper`) | Rentals only: rent, beds, baths, address, lat/lng, agent name and phone, available-from | |
| `apify`: OnTheMarket (`fatihtahta~onthemarket-scraper`) | Rentals: rent, beds, address, lat/lng, agent name and phone, fees/deposit | about 10s, about $0.002 per listing |
| `apify`: OpenRent (`vivid-softwares~openrent-property-scraper`) | Landlord-direct: rent, beds, baths, furnished, **minimum tenancy**, available-from, deposit, landlord name | about 6s, about $0.015 per listing (max 20). Contact is via OpenRent messaging |
| ONS Price Index of Private Rents | Official average monthly rent by local authority → region → country, for 1/2/3/4+ bed | Free. The monthly cron (25th, 06:00 UTC) refreshes it into KV. `GET /api/ons` shows the loaded month |
| `propertydata` (optional) | Area rent benchmark and rent-to-rent list | Only runs if `PROPERTYDATA_KEY` is set |

Rightmove's terms of use prohibit scraping. It is enabled here for a low-volume trial.
Each search takes about 30–60s, because the portals run in parallel. It costs roughly $0.50 in Apify credit: most of that is OpenRent, and 30 results per portal is the default (`APIFY_MAX_RESULTS`). Drop a portal from `APIFY_PORTALS` to cut cost.

The ONS refresh needs Workers Paid, because parsing the 19 MB workbook takes a few seconds of CPU. It streams the sheet and stores about 25 KB in KV.

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
src/index.ts          routes + access cookie
src/pipeline.ts       validate → geocode → sources → localise → dedupe/rank → economics
src/sources/apify.ts  Rightmove, Zoopla, OnTheMarket, OpenRent (rentals)
src/ons.ts            ONS rent data: zip/xlsx stream parser, monthly refresh, area lookup
src/sources/propertydata.ts
src/geo.ts, parse.ts, economics.ts, ui.ts, types.ts
test/smoke.ts, test/ons.test.ts (+ fixtures/pipr-mini.xlsx)
```

## Roadmap

Phase 3: take the enquiry straight from the Enquiry App.
Candidates: save shortlists and outreach status in D1.

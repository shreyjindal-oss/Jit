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

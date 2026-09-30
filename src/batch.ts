import type { Env } from "./types";
import { entryText, zipEntries } from "./ons";
import { runSearch, validate } from "./pipeline";
import { newId, saveSearch, searchesToday } from "./db";

/**
 * Bulk upload: a CSV or XLSX sheet, one enquiry per row. Rows are queued in D1 and processed in the
 * background by the every-minute cron (BATCH_CONCURRENCY rows per tick), each saved as a normal search.
 */

export const TEMPLATE_CSV =
  "location,check_in,check_out,bedrooms,bathrooms,min_rent_pcm,max_rent_pcm,radius_miles,property_type,furnished,accessibility,must_have,client_account,enquiry_ref,sell_rate_nightly\n" +
  "Canary Wharf London,2026-11-01,2027-02-01,2,1,,3500,2,flat,furnished,any,parking,Example Relocations,ENQ-1001,175\n" +
  "M1 1AE,01/12/2026,01/03/2027,3;4,2,,,3,house;bungalow,any,ground floor,parking;pets,Example Housing Assoc,ENQ-1002,\n";

// Header aliases → our field names
const ALIASES: Record<string, string> = {
  location: "location", postcode: "location", area: "location", city: "location", address: "location",
  check_in: "checkIn", checkin: "checkIn", arrival: "checkIn", start_date: "checkIn", from: "checkIn", move_in: "checkIn",
  check_out: "checkOut", checkout: "checkOut", departure: "checkOut", end_date: "checkOut", to: "checkOut", move_out: "checkOut",
  bedrooms: "bedrooms", beds: "bedrooms", bed_type: "bedrooms", bedroom: "bedrooms", apartment_type: "bedrooms",
  bathrooms: "bathrooms", baths: "bathrooms",
  max_rent_pcm: "maxRentPcm", max_rent: "maxRentPcm", budget: "maxRentPcm", budget_pcm: "maxRentPcm",
  radius_miles: "radiusMiles", radius: "radiusMiles",
  furnished: "furnished", furnishing: "furnished",
  min_rent_pcm: "minRentPcm", min_rent: "minRentPcm",
  property_type: "propertyTypes", property_types: "propertyTypes", type: "propertyTypes",
  must_have: "mustHave", must_haves: "mustHave", features: "mustHave", amenities: "mustHave",
  min_size_sq_ft: "minSizeSqFt", min_sqft: "minSizeSqFt",
  added_within_days: "addedWithinDays",
  accessibility: "accessibility", access: "accessibility", accessible: "accessibility",
  client_account: "clientAccount", client: "clientAccount", account: "clientAccount",
  enquiry_ref: "enquiryRef", enquiry: "enquiryRef", enquiry_id: "enquiryRef", ref: "enquiryRef", reference: "enquiryRef",
  sell_rate_nightly: "sellRateNightly", sell_rate: "sellRateNightly", nightly_rate: "sellRateNightly",
  setup_cost: "setupCost",
};
const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function toIsoDate(v: string): string {
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const uk = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); // UK day-first
  if (uk) { const y = uk[3].length === 2 ? `20${uk[3]}` : uk[3]; return `${y}-${uk[2].padStart(2, "0")}-${uk[1].padStart(2, "0")}`; }
  const n = Number(s);
  if (Number.isFinite(n) && n > 30000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10); // Excel serial
  const d = new Date(s);
  return isNaN(+d) ? s : d.toISOString().slice(0, 10);
}
/** "2", "2 bed", "Studio", "2;3", "2-3 bed", "studio or 1 bed" → "2" / "2,3" / "0,1" */
function toBeds(v: string): string {
  const s = String(v ?? "").toLowerCase();
  const range = s.match(/(\d)\s*(?:-|–|to)\s*(\d)/);
  const out = new Set<number>();
  if (/studio/.test(s)) out.add(0);
  if (range) for (let b = +range[1]; b <= +range[2]; b++) out.add(b);
  else for (const m of s.matchAll(/\d+/g)) out.add(+m[0]);
  return out.size ? [...out].sort((a, b) => a - b).join(",") : s;
}
/** "ground floor; wheelchair" → "ground_floor,wheelchair" */
function toAccess(v: string): string {
  const s = String(v ?? "").toLowerCase(), out: string[] = [];
  if (/wheel/.test(s)) out.push("wheelchair");
  if (/step|lift|level/.test(s)) out.push("step_free");
  if (/ground|bungalow/.test(s)) out.push("ground_floor");
  return out.join(",") || "any";
}

/** Raw rows → request bodies for validate(). */
export function rowsToBodies(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const [h, v] of Object.entries(row)) { const f = ALIASES[key(h)]; if (f && v !== "" && v != null) out[f] = String(v).trim(); }
    if (out.checkIn) out.checkIn = toIsoDate(out.checkIn);
    if (out.checkOut) out.checkOut = toIsoDate(out.checkOut);
    if (out.bedrooms) out.bedrooms = toBeds(out.bedrooms);
    if (out.maxRentPcm) out.maxRentPcm = out.maxRentPcm.replace(/[£,\s]/g, "");
    if (out.sellRateNightly) out.sellRateNightly = out.sellRateNightly.replace(/[£,\s]/g, "");
    if (out.minRentPcm) out.minRentPcm = out.minRentPcm.replace(/[£,\s]/g, "");
    if (out.furnished) { // "furnished", "part furnished; unfurnished", "yes", "any"
      const f = out.furnished.toLowerCase(), set: string[] = [];
      if (/part/.test(f)) set.push("part_furnished");
      if (/unfurn|^no$/.test(f)) set.push("unfurnished");
      if (/(?:^|[^a-z])furn|yes/.test(f.replace(/part[ -]?furnished|unfurnished/g, ""))) set.push("furnished");
      delete out.furnished; if (set.length) out.furnishing = set.join(",");
    }
    const acc = toAccess(out.accessibility ?? "");
    delete out.accessibility; if (acc !== "any") out.accessNeeds = acc;
    return out;
  });
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { cur.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; cur.push(cell); rows.push(cur); cur = []; cell = ""; }
    else cell += c;
  }
  if (cell || cur.length) { cur.push(cell); rows.push(cur); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ""), r[i] ?? ""])));
}

async function parseXlsx(buf: ArrayBuffer): Promise<Record<string, string>[]> {
  const entries = zipEntries(buf);
  const ss = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const shared = ss ? [...(await entryText(buf, ss)).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")) : [];
  const sheet = entries.find((e) => e.name === "xl/worksheets/sheet1.xml") ?? entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!sheet) throw new Error("No worksheet found in the xlsx");
  const xml = await entryText(buf, sheet);
  const grid: Record<string, string>[] = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Record<string, string> = {};
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const inner = c[3] ?? "";
      const v = /t="inlineStr"/.test(c[2]) ? inner.replace(/<[^>]+>/g, "") : inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "";
      cells[c[1]] = /t="s"/.test(c[2]) ? shared[Number(v)] ?? "" : v;
    }
    grid.push(cells);
  }
  const [head, ...body] = grid.filter((r) => Object.values(r).some((v) => String(v).trim() !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(Object.entries(head).map(([col, h]) => [h, r[col] ?? ""])));
}

export async function parseSheet(buf: ArrayBuffer, filename = ""): Promise<Record<string, string>[]> {
  const isZip = new Uint8Array(buf.slice(0, 2)).join(",") === "80,75"; // "PK"
  if (isZip || /\.xlsx$/i.test(filename)) return parseXlsx(buf);
  return parseCsv(new TextDecoder().decode(buf));
}

export async function createBatch(env: Env, buf: ArrayBuffer, filename: string) {
  if (!env.DB) throw new Error("DB binding missing — create the D1 database (see README)");
  const bodies = rowsToBodies(await parseSheet(buf, filename));
  const max = Number(env.MAX_BATCH_ROWS || 50);
  if (!bodies.length) throw new Error("No rows found. Use the template: location, check_in, check_out, bedrooms, …");
  if (bodies.length > max) throw new Error(`Sheet has ${bodies.length} rows; the limit is ${max} per upload (MAX_BATCH_ROWS).`);
  const invalid: { row: number; error: string }[] = [];
  const valid: { row: number; req: any }[] = [];
  bodies.forEach((b, i) => { const { req, error } = validate(b); if (req) valid.push({ row: i + 2, req }); else invalid.push({ row: i + 2, error: error! }); });
  if (!valid.length) return { batchId: null, queued: 0, invalid };
  const id = newId();
  const now = new Date().toISOString();
  const stmts = [env.DB.prepare(`INSERT INTO batches (id, created_at, filename, total, status) VALUES (?1,?2,?3,?4,'queued')`).bind(id, now, filename, valid.length)];
  for (const v of valid) stmts.push(env.DB.prepare(`INSERT INTO batch_rows (batch_id, row_no, request_json) VALUES (?1,?2,?3)`).bind(id, v.row, JSON.stringify(v.req)));
  await env.DB.batch(stmts);
  return { batchId: id, queued: valid.length, invalid };
}

/** One cron tick: reset stuck rows, then run up to BATCH_CONCURRENCY pending rows in parallel. */
export async function processBatchTick(env: Env): Promise<{ processed: number }> {
  if (!env.DB) return { processed: 0 };
  const stale = new Date(Date.now() - 10 * 60000).toISOString();
  await env.DB.prepare(`UPDATE batch_rows SET status='pending' WHERE status='running' AND started_at < ?1 AND attempts < 2`).bind(stale).run();
  await env.DB.prepare(`UPDATE batch_rows SET status='error', error='timed out twice' WHERE status='running' AND started_at < ?1 AND attempts >= 2`).bind(stale).run();

  const n = Number(env.BATCH_CONCURRENCY || 1);
  const { results } = await env.DB.prepare(`SELECT batch_id, row_no, request_json FROM batch_rows WHERE status='pending' ORDER BY batch_id, row_no LIMIT ?1`).bind(n).all<any>();
  if (!results.length) return { processed: 0 };

  const cap = Number(env.MAX_SEARCHES_PER_DAY || 100);
  if ((await searchesToday(env)) >= cap) return { processed: 0 }; // wait for tomorrow; rows stay pending

  const now = new Date().toISOString();
  // Claim atomically (only if still pending) so overlapping ticks never run the same row twice.
  const claimed: any[] = [];
  for (const r of results) {
    const c: any = await env.DB.prepare(`UPDATE batch_rows SET status='running', attempts=attempts+1, started_at=?3 WHERE batch_id=?1 AND row_no=?2 AND status='pending'`).bind(r.batch_id, r.row_no, now).run();
    if ((c?.meta?.changes ?? 1) > 0) claimed.push(r);
  }
  if (!claimed.length) return { processed: 0 };
  results.splice(0, results.length, ...claimed);
  await env.DB.batch([...new Set(results.map((r) => r.batch_id))].map((b) => env.DB!.prepare(`UPDATE batches SET status='running' WHERE id=?1`).bind(b)));

  await Promise.all(results.map(async (r) => {
    const t0 = Date.now();
    try {
      const res = await runSearch(JSON.parse(r.request_json), env);
      // Portals down (e.g. Apify credit used up): fail the row instead of saving a misleading "0 listings" search.
      const down = res.sources.find((s) => s.source === "apify" && !s.ok && s.error);
      if (down && !res.listings.length) {
        const credit = /402|403|platform-feature-disabled|usage|limit|credit|quota/i.test(down.error!);
        throw new Error(`${credit ? "Apify credit/limit reached" : "Portal search failed"} — retry later. ${down.error!.slice(0, 160)}`);
      }
      const searchId = await saveSearch(env, res, { source: "batch", batchId: r.batch_id, durationMs: Date.now() - t0 });
      await env.DB!.prepare(`UPDATE batch_rows SET status='done', search_id=?3, listing_count=?4, finished_at=?5, error=NULL WHERE batch_id=?1 AND row_no=?2`)
        .bind(r.batch_id, r.row_no, searchId, res.listings.length, new Date().toISOString()).run();
    } catch (e: any) {
      await env.DB!.prepare(`UPDATE batch_rows SET status='error', error=?3, finished_at=?4 WHERE batch_id=?1 AND row_no=?2`)
        .bind(r.batch_id, r.row_no, String(e?.message ?? e).slice(0, 500), new Date().toISOString()).run();
    }
  }));
  // Close finished batches
  await env.DB.prepare(`UPDATE batches SET status='done' WHERE status='running' AND NOT EXISTS (SELECT 1 FROM batch_rows br WHERE br.batch_id=batches.id AND br.status IN ('pending','running'))`).run();
  return { processed: results.length };
}

export async function listBatches(env: Env): Promise<any[]> {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.created_at, b.filename, b.total, b.status,
       SUM(CASE WHEN r.status='done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN r.status='error' THEN 1 ELSE 0 END) AS errors,
       SUM(CASE WHEN r.status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
       SUM(CASE WHEN r.status='pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN r.status='done' AND COALESCE(r.listing_count,0)=0 THEN 1 ELSE 0 END) AS empty,
       SUM(COALESCE(r.listing_count,0)) AS listings
     FROM batches b LEFT JOIN batch_rows r ON r.batch_id = b.id WHERE b.archived_at IS NULL GROUP BY b.id ORDER BY b.created_at DESC LIMIT 30`,
  ).all();
  return results;
}

export async function getBatch(env: Env, id: string) {
  if (!env.DB) return null;
  const b = await env.DB.prepare(`SELECT * FROM batches WHERE id=?1`).bind(id).first();
  if (!b) return null;
  const { results } = await env.DB.prepare(`SELECT row_no, status, attempts, request_json, search_id, listing_count, error FROM batch_rows WHERE batch_id=?1 ORDER BY row_no`).bind(id).all<any>();
  return { ...b, rows: results.map((r) => ({ ...r, request: JSON.parse(r.request_json), request_json: undefined })) };
}

/** Flat CSV of every listing found for a batch (one line per listing, with its enquiry row). */
export async function batchCsv(env: Env, id: string): Promise<string> {
  const { results } = await env.DB!.prepare(
    `SELECT br.row_no, s.enquiry_ref, s.client_account, s.location, s.bedrooms, s.check_in, s.check_out, s.accessibility,
            l.rank, l.portal, l.address, l.url, l.rent_pcm, l.bedrooms AS l_beds, l.bathrooms, l.available_from, l.furnished, l.floor, l.access_fit,
            l.agent_name, l.agent_phone, l.distance_miles, l.score, l.images_json
       FROM batch_rows br JOIN searches s ON s.id = br.search_id JOIN listings l ON l.search_id = s.id
      WHERE br.batch_id = ?1 ORDER BY br.row_no, l.rank`,
  ).bind(id).all<any>();
  const head = ["row", "enquiry_ref", "client_account", "location", "bedrooms", "check_in", "check_out", "accessibility", "rank", "portal", "address", "url", "rent_pcm", "listing_beds", "baths", "available_from", "furnished", "floor", "access_fit", "agent", "agent_phone", "distance_miles", "score", "main_image"];
  const c = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [head.join(","), ...results.map((r) => [r.row_no, r.enquiry_ref, r.client_account, r.location, r.bedrooms, r.check_in, r.check_out, r.accessibility, r.rank, r.portal, r.address, r.url, r.rent_pcm, r.l_beds, r.bathrooms, r.available_from, r.furnished, r.floor, r.access_fit, r.agent_name, r.agent_phone, r.distance_miles, r.score, JSON.parse(r.images_json || "[]")[0]].map(c).join(","))].join("\n");
}

/** Stop a bulk upload: rows not started yet are cancelled (a row already running finishes). */
export async function cancelBatch(env: Env, id: string): Promise<{ cancelled: number }> {
  if (!env.DB) return { cancelled: 0 };
  const r: any = await env.DB.prepare(`UPDATE batch_rows SET status='cancelled', error='cancelled by user' WHERE batch_id=?1 AND status='pending'`).bind(id).run();
  await env.DB.prepare(`UPDATE batches SET status='cancelled' WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM batch_rows br WHERE br.batch_id=?1 AND br.status='running')`).bind(id).run();
  return { cancelled: r?.meta?.changes ?? 0 };
}

/** Re-queue failed/cancelled rows (and, with `empty`, rows that finished with 0 listings) — e.g. after topping up Apify. */
export async function retryBatch(env: Env, id: string, empty = false): Promise<{ requeued: number }> {
  if (!env.DB) return { requeued: 0 };
  const r: any = await env.DB.prepare(
    `UPDATE batch_rows SET status='pending', attempts=0, error=NULL, started_at=NULL, finished_at=NULL
     WHERE batch_id=?1 AND (status IN ('error','cancelled') OR (?2 = 1 AND status='done' AND COALESCE(listing_count,0)=0))`,
  ).bind(id, empty ? 1 : 0).run();
  const n = r?.meta?.changes ?? 0;
  if (n) await env.DB.prepare(`UPDATE batches SET status='queued' WHERE id=?1`).bind(id).run();
  return { requeued: n };
}

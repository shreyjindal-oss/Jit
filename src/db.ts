import type { Env, SearchResponse } from "./types";

/** D1 persistence for searches + their listings. All functions no-op gracefully without a DB binding. */

export const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export async function saveSearch(env: Env, res: SearchResponse, opts: { source: "ui" | "batch" | "api" | "alert" | "curated"; batchId?: string; durationMs?: number }): Promise<string | null> {
  if (!env.DB) return null;
  const id = newId();
  const r = res.request;
  const { listings, ...summary } = res;
  const rents = listings.filter((l) => l.rentPcm && (r.bedroomOptions ?? [r.bedrooms]).includes(l.bedrooms ?? -1)).map((l) => l.rentPcm!);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO searches (id, created_at, source, batch_id, location, outcode, la_name, bedrooms, bathrooms, check_in, check_out, accessibility,
        client_account, enquiry_ref, listing_count, median_rent_pcm, ons_pcm, duration_ms, request_json, summary_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`,
    ).bind(
      id, nowIso(), opts.source, opts.batchId ?? null, r.location, res.geo?.outcode ?? null, res.geo?.district ?? res.geo?.town ?? null,
      r.bedrooms, r.bathrooms ?? null, r.checkIn, r.checkOut, r.accessNeeds?.join(",") || r.accessibility || "any", r.clientAccount ?? null, r.enquiryRef ?? null,
      listings.length, median(rents), res.ons?.avgPcm ?? null, opts.durationMs ?? null, JSON.stringify(r), JSON.stringify(summary),
    ),
  ];
  listings.forEach((l, i) =>
    stmts.push(
      env.DB!.prepare(
        `INSERT INTO listings (search_id, rank, portal, url, title, address, outcode, bedrooms, bathrooms, rent_pcm, available_from, furnished,
          floor, access_fit, access_json, agent_name, agent_phone, lat, lng, distance_miles, score, flags_json, images_json, snippet)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`,
      ).bind(
        id, i + 1, l.portal, l.url ?? null, l.title?.slice(0, 300) ?? null, l.address ?? null, l.outcode ?? null, l.bedrooms ?? null, l.bathrooms ?? null,
        l.rentPcm ?? null, l.availableFrom ?? null, l.furnished ?? null, l.floor ?? null, l.accessFit ?? null, JSON.stringify(l.access ?? []),
        l.agentName ?? null, l.agentPhone ?? null, l.lat ?? null, l.lng ?? null, l.distanceMiles ?? null, l.score,
        JSON.stringify(l.flags ?? []), JSON.stringify(l.images ?? []), l.snippet?.slice(0, 500) ?? null,
      ),
    ),
  );
  // D1 batches are atomic; keep them to a safe size.
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return id;
}

export async function listSearches(env: Env, limit = 50, q?: string, archived = false): Promise<any[]> {
  if (!env.DB) return [];
  const conds = [archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  if (q) conds.push("(location LIKE ?2 OR outcode LIKE ?2 OR enquiry_ref LIKE ?2 OR client_account LIKE ?2)");
  const stmt = env.DB.prepare(
    `SELECT id, created_at, source, batch_id, location, outcode, la_name, bedrooms, check_in, check_out, accessibility, client_account, enquiry_ref,
            listing_count, median_rent_pcm, ons_pcm, archived_at FROM searches WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?1`,
  );
  const { results } = await (q ? stmt.bind(limit, `%${q}%`) : stmt.bind(limit)).all();
  return results;
}

/**
 * Save a cleaned copy of a saved search that keeps only listings with the given bed counts
 * (e.g. an all-sizes run trimmed to 4 & 5 bed). The original is left untouched (archive it separately).
 */
export async function deriveSearch(env: Env, id: string, opts: { bedrooms: number[]; enquiryRef?: string; clientAccount?: string }): Promise<{ id: string | null; kept: number } | null> {
  const s: any = await getSearch(env, id);
  if (!s) return null;
  const beds = [...new Set(opts.bedrooms)].sort((a, b) => a - b);
  const listings = s.listings.filter((l: any) => l.kind !== "search_page" && l.bedrooms !== undefined && beds.includes(l.bedrooms));
  const { id: _id, savedAt: _saved, ...rest } = s;
  const request = { ...s.request, bedrooms: beds[0], bedroomOptions: beds.length > 1 ? beds : undefined,
    ...(opts.enquiryRef ? { enquiryRef: opts.enquiryRef } : {}), ...(opts.clientAccount ? { clientAccount: opts.clientAccount } : {}) };
  const warnings = [...(s.warnings ?? []), `Filtered copy of an earlier search (${s.savedAt?.slice(0, 10)}), keeping ${beds.join(" & ")} bed listings only.`];
  const newId = await saveSearch(env, { ...rest, request, listings, warnings } as any, { source: "curated" });
  return { id: newId, kept: listings.length };
}

/** Archive / restore saved searches, bulk uploads and alerts (archived alerts are also stopped). Nothing is deleted. */
export async function setArchived(env: Env, kind: "searches" | "batches" | "alerts", ids: string[], archived: boolean): Promise<number> {
  if (!env.DB || !ids.length) return 0;
  const now = new Date().toISOString();
  let n = 0;
  for (const id of ids) {
    const r: any = await env.DB.prepare(`UPDATE ${kind} SET archived_at = ?2 WHERE id = ?1`).bind(id, archived ? now : null).run();
    n += r?.meta?.changes ?? 1;
    if (archived && kind === "alerts") await env.DB.prepare(`UPDATE alerts SET status='stopped' WHERE id=?1 AND status='active'`).bind(id).run();
    if (archived && kind === "batches") await env.DB.prepare(`UPDATE batch_rows SET status='cancelled', error='archived' WHERE batch_id=?1 AND status='pending'`).bind(id).run();
  }
  return n;
}

/** IDs of everything not archived (for "archive all except …"). */
export async function activeIds(env: Env, kind: "searches" | "batches" | "alerts"): Promise<string[]> {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(`SELECT id FROM ${kind} WHERE archived_at IS NULL`).all<any>();
  return results.map((r) => r.id);
}

/** Rebuild a stored search into the same shape /api/search returns. */
export async function getSearch(env: Env, id: string): Promise<(SearchResponse & { id: string; savedAt: string }) | null> {
  if (!env.DB) return null;
  const s: any = await env.DB.prepare(`SELECT * FROM searches WHERE id = ?1`).bind(id).first();
  if (!s) return null;
  const { results } = await env.DB.prepare(`SELECT * FROM listings WHERE search_id = ?1 ORDER BY rank`).bind(id).all<any>();
  const summary = JSON.parse(s.summary_json || "{}");
  return {
    ...summary,
    id,
    savedAt: s.created_at,
    request: JSON.parse(s.request_json),
    listings: results.map((l) => ({
      id: `saved-${l.id}`, source: "apify", portal: l.portal, kind: "listing", title: l.title, address: l.address, outcode: l.outcode,
      bedrooms: l.bedrooms ?? undefined, bathrooms: l.bathrooms ?? undefined, rentPcm: l.rent_pcm ?? undefined, availableFrom: l.available_from ?? undefined,
      furnished: l.furnished ?? undefined, floor: l.floor ?? undefined, accessFit: l.access_fit ?? undefined, access: JSON.parse(l.access_json || "[]"),
      agentName: l.agent_name ?? undefined, agentPhone: l.agent_phone ?? undefined, url: l.url ?? undefined, lat: l.lat ?? undefined, lng: l.lng ?? undefined,
      distanceMiles: l.distance_miles ?? undefined, score: l.score, flags: JSON.parse(l.flags_json || "[]"), images: JSON.parse(l.images_json || "[]"),
      snippet: l.snippet ?? undefined,
    })),
  };
}

/** Cost guard: searches run today (UTC), UI + bulk combined. */
export async function searchesToday(env: Env): Promise<number> {
  if (!env.DB) return 0;
  const r: any = await env.DB.prepare(`SELECT COUNT(*) AS n FROM searches WHERE created_at >= ?1`).bind(new Date().toISOString().slice(0, 10)).first();
  return r?.n ?? 0;
}

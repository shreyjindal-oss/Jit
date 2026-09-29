import type { Env, SearchResponse } from "./types";

/** D1 persistence for searches + their listings. All functions no-op gracefully without a DB binding. */

export const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export async function saveSearch(env: Env, res: SearchResponse, opts: { source: "ui" | "batch" | "api"; batchId?: string; durationMs?: number }): Promise<string | null> {
  if (!env.DB) return null;
  const id = newId();
  const r = res.request;
  const { listings, ...summary } = res;
  const rents = listings.filter((l) => l.rentPcm && l.bedrooms === r.bedrooms).map((l) => l.rentPcm!);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO searches (id, created_at, source, batch_id, location, outcode, la_name, bedrooms, bathrooms, check_in, check_out, accessibility,
        client_account, enquiry_ref, listing_count, median_rent_pcm, ons_pcm, duration_ms, request_json, summary_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`,
    ).bind(
      id, nowIso(), opts.source, opts.batchId ?? null, r.location, res.geo?.outcode ?? null, res.geo?.district ?? res.geo?.town ?? null,
      r.bedrooms, r.bathrooms ?? null, r.checkIn, r.checkOut, r.accessibility ?? "any", r.clientAccount ?? null, r.enquiryRef ?? null,
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

export async function listSearches(env: Env, limit = 50, q?: string): Promise<any[]> {
  if (!env.DB) return [];
  const where = q ? `WHERE location LIKE ?2 OR outcode LIKE ?2 OR enquiry_ref LIKE ?2 OR client_account LIKE ?2` : "";
  const stmt = env.DB.prepare(
    `SELECT id, created_at, source, batch_id, location, outcode, la_name, bedrooms, check_in, check_out, accessibility, client_account, enquiry_ref,
            listing_count, median_rent_pcm, ons_pcm FROM searches ${where} ORDER BY created_at DESC LIMIT ?1`,
  );
  const { results } = await (q ? stmt.bind(limit, `%${q}%`) : stmt.bind(limit)).all();
  return results;
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

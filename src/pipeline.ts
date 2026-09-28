import type { Env, Listing, SearchRequest, SearchResponse, SourceId, SourceStatus } from "./types";
import { geocode, milesBetween, outcodeCentre } from "./geo";
import type { GeoPoint } from "./types";
import { economics } from "./economics";
import { getOns, onsLookup } from "./ons";
import { rentBenchmark, rentToRent } from "./sources/propertydata";
import { apifyListings } from "./sources/apify";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function validate(body: any): { req?: SearchRequest; error?: string } {
  const n = (v: any) => (v === "" || v == null ? undefined : Number(v));
  const req: SearchRequest = {
    location: String(body?.location ?? "").trim(),
    checkIn: String(body?.checkIn ?? ""),
    checkOut: String(body?.checkOut ?? ""),
    bedrooms: Number(body?.bedrooms ?? NaN),
    bathrooms: n(body?.bathrooms),
    beds: n(body?.beds),
    maxRentPcm: n(body?.maxRentPcm),
    furnished: ["furnished", "unfurnished"].includes(body?.furnished) ? body.furnished : "any",
    radiusMiles: n(body?.radiusMiles),
    sellRateNightly: n(body?.sellRateNightly),
    setupCost: n(body?.setupCost),
    clientAccount: body?.clientAccount ? String(body.clientAccount) : undefined,
    enquiryRef: body?.enquiryRef ? String(body.enquiryRef) : undefined,
  };
  if (!req.location) return { error: "location is required" };
  if (!ISO.test(req.checkIn) || !ISO.test(req.checkOut)) return { error: "checkIn/checkOut must be YYYY-MM-DD" };
  if (Date.parse(req.checkOut) <= Date.parse(req.checkIn)) return { error: "checkOut must be after checkIn" };
  if (!Number.isInteger(req.bedrooms) || req.bedrooms < 0 || req.bedrooms > 6) return { error: "bedrooms must be 0 (studio) to 6" };
  return { req };
}

function score(l: Listing, req: SearchRequest, benchPcm?: number): number {
  let s = 0;
  if (l.bedrooms === req.bedrooms) s += 30; else if (l.bedrooms === undefined) s += 10;
  if (req.bathrooms && l.bathrooms !== undefined) s += l.bathrooms >= req.bathrooms ? 10 : -10;
  if (l.rentPcm) {
    s += 5;
    if (req.maxRentPcm) s += l.rentPcm <= req.maxRentPcm ? 10 : -10;
    if (benchPcm) s += l.rentPcm <= benchPcm ? 10 : l.rentPcm <= benchPcm * 1.15 ? 4 : -5;
  }
  if (l.distanceMiles !== undefined) s += Math.max(0, 10 - l.distanceMiles * 2);
  else s += 4;
  if (l.kind === "listing") s += 10;
  if (l.agentPhone || l.agentEmail) s += 10;
  if (l.availableFrom) s += 5;
  if (l.flags.includes("rent-to-rent friendly")) s += 10;
  if (l.flags.some((f) => f.startsWith("let agreed"))) s -= 25;
  if (l.flags.includes("area unverified")) s -= 15;
  if (l.minTenancyMonths !== undefined) {
    const stayMonths = (Date.parse(req.checkOut) - Date.parse(req.checkIn)) / 86400000 / 30.44;
    s += l.minTenancyMonths <= Math.ceil(stayMonths) ? 10 : -5;
  }
  if (req.furnished === "furnished" && l.furnished === "Unfurnished") s -= 10;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function normUrl(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "")).toLowerCase();
  } catch { return u; }
}

export function rankAndFilter(all: Listing[], req: SearchRequest, benchPcm?: number): Listing[] {
  const seen = new Map<string, Listing>();
  for (const l of all) {
    // Hard filters: a known wrong bed count, or rent >15% over the ceiling.
    if (l.bedrooms !== undefined && l.bedrooms !== req.bedrooms && l.kind === "listing") continue;
    if (req.maxRentPcm && l.rentPcm && l.rentPcm > req.maxRentPcm * 1.15) continue;
    if (req.bathrooms && l.bathrooms !== undefined && l.bathrooms < req.bathrooms) l.flags.push(`only ${l.bathrooms} bath`);
    if (req.furnished === "furnished" && l.furnished === "Unfurnished") l.flags.push("unfurnished — needs fit-out");
    const key = normUrl(l.url) ?? `${l.address}|${l.rentPcm}`;
    const prev = seen.get(key);
    // Same property from several sources: earlier (richer) source wins per field; later ones fill gaps.
    if (!prev) { seen.set(key, l); continue; }
    const merged: any = { ...prev };
    for (const [k, v] of Object.entries(l)) if (merged[k] === undefined || merged[k] === "") merged[k] = v;
    merged.flags = [...new Set([...prev.flags, ...l.flags])];
    if (!prev.portal.includes(l.portal)) merged.portal = `${prev.portal} + ${l.portal}`;
    seen.set(key, merged);
  }
  return [...seen.values()]
    .map((l) => ({ ...l, score: score(l, req, benchPcm) }))
    .sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === "listing" ? -1 : 1));
}

/**
 * Keep results in the requested area. Google often returns listings from the wider region
 * (e.g. Barking for "Canary Wharf"). We place each listing by its postcode district and drop
 * anything well outside the radius; listings we can't place are flagged, not dropped.
 */
export async function localise(ls: Listing[], geo: GeoPoint | undefined, req: SearchRequest): Promise<Listing[]> {
  if (!geo) return ls;
  const radius = req.radiusMiles ?? 3;
  const maxMiles = Math.max(radius * 2, radius + 3);
  const ocs = [...new Set(ls.filter((l) => l.distanceMiles === undefined && l.outcode).map((l) => l.outcode!))].slice(0, 25);
  const centres = new Map(await Promise.all(ocs.map(async (oc) => [oc, await outcodeCentre(oc).catch(() => null)] as const)));
  const areaWords = [req.location.split(",")[0], geo.town, geo.outcode].filter(Boolean).map((w) => w!.toLowerCase().trim());
  const out: Listing[] = [];
  for (const l of ls) {
    if (l.distanceMiles === undefined && l.outcode) {
      const c = centres.get(l.outcode);
      if (c) l.distanceMiles = milesBetween(geo, c);
    }
    if (l.distanceMiles !== undefined) {
      if (l.distanceMiles > maxMiles) continue;
    } else if (l.kind === "listing") {
      const text = `${l.title} ${l.address ?? ""} ${l.snippet ?? ""}`.toLowerCase();
      if (!areaWords.some((w) => text.includes(w))) l.flags.push("area unverified");
    }
    out.push(l);
  }
  return out;
}

async function timed<T>(source: SourceStatus["source"], statuses: SourceStatus[], fn: () => Promise<T>): Promise<T | undefined> {
  const t = Date.now();
  try {
    const v = await fn();
    statuses.push({ source, ok: true, count: Array.isArray(v) ? v.length : v ? 1 : 0, ms: Date.now() - t });
    return v;
  } catch (e: any) {
    statuses.push({ source, ok: false, error: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t });
    return undefined;
  }
}

export async function runSearch(req: SearchRequest, env: Env): Promise<SearchResponse> {
  const statuses: SourceStatus[] = [];
  const warnings: string[] = [];
  const enabled = new Set((env.ENABLED_SOURCES || "apify,propertydata").split(",").map((s) => s.trim()) as SourceId[]);
  req.radiusMiles ??= Number(env.DEFAULT_RADIUS_MILES || 3);
  const minLease = Number(env.MIN_LEASE_MONTHS || 6);

  const geo = await timed("geocode", statuses, async () => {
    const g = await geocode(req.location);
    if (!g) throw new Error(`Could not locate "${req.location}"`);
    return g;
  });

  const skip = (source: SourceId, why: string) => statuses.push({ source, ok: false, skipped: why });
  const has = (id: SourceId, key: string | undefined, keyName: string, needsGeo = true) => {
    if (!enabled.has(id)) { skip(id, "disabled in ENABLED_SOURCES"); return false; }
    if (!key) { skip(id, `${keyName} not set`); return false; }
    if (needsGeo && !geo) { skip(id, "location not geocoded"); return false; }
    return true;
  };

  const tasks = {
    bench: has("propertydata", env.PROPERTYDATA_KEY, "PROPERTYDATA_KEY") ? timed("propertydata", statuses, () => rentBenchmark(req, geo!, env)) : undefined,
    r2r: enabled.has("propertydata") && env.PROPERTYDATA_KEY && geo ? timed("propertydata", statuses, () => rentToRent(req, geo!, env)) : undefined,
    apify: enabled.has("apify") ? (has("apify", env.APIFY_TOKEN, "APIFY_TOKEN") ? timed("apify", statuses, () => apifyListings(req, geo!, env)) : undefined) : undefined,
  };
  if (!enabled.has("apify")) skip("apify", "disabled in ENABLED_SOURCES");

  const [bench, r2r, apify] = await Promise.all([tasks.bench, tasks.r2r, tasks.apify]);
  const benchPcm = bench?.avgPcm;
  const placed = await localise([...(apify ?? []), ...(r2r ?? [])], geo, req);
  const listings = rankAndFilter(placed, req, benchPcm);
  // ONS official area average (free; refreshed monthly into KV by the cron trigger).
  let ons: ReturnType<typeof onsLookup> = null;
  if (geo) {
    const t0 = Date.now();
    const data = await getOns(env).catch(() => null);
    ons = data ? onsLookup(data, geo, req.bedrooms) : null;
    statuses.push(data ? { source: "ons", ok: !!ons, count: ons ? 1 : 0, ms: Date.now() - t0, ...(ons ? {} : { skipped: "no ONS area match" }) } : { source: "ons", ok: false, skipped: env.ONS_KV ? "no ONS data yet — run /api/ons/refresh once" : "ONS_KV binding not set" });
  }
  // Sanity check against the official average: a "2-bed" at a fraction of the area rent is usually a room/share or a mis-typed weekly price.
  if (ons?.avgPcm) for (const l of listings) if (l.rentPcm && l.rentPcm < ons.avgPcm * 0.45) { l.flags.push("rent looks too low — check (room/share?)"); l.score = Math.max(0, l.score - 30); }
  listings.sort((a, b) => b.score - a.score);
  for (const l of listings) {
    if (l.minTenancyMonths !== undefined) {
      const stayMonths = Math.ceil((Date.parse(req.checkOut) - Date.parse(req.checkIn)) / 86400000 / 30.44);
      if (l.minTenancyMonths <= stayMonths) l.flags.push("tenancy fits stay");
    }
  }
  const econ = economics(req, minLease, bench, listings, ons?.avgPcm);

  if (!env.APIFY_TOKEN) warnings.push("APIFY_TOKEN not set — no Rightmove/Zoopla listings. Add it to .dev.vars (local) or `wrangler secret put APIFY_TOKEN`.");
  const apifyFail = statuses.find((st) => st.source === "apify" && !st.ok && st.error);
  if (apifyFail) warnings.push(/401|token/i.test(apifyFail.error!) ? "Apify rejected the APIFY_TOKEN — re-set it with `npx wrangler secret put APIFY_TOKEN` (paste only the apify_api_… value, no quotes/spaces)." : `Rightmove/Zoopla search failed: ${apifyFail.error!.slice(0, 200)}`);
  for (const e of ((apify as any)?.errors ?? []) as string[]) warnings.push(`One portal failed: ${e.slice(0, 160)}`);
  if (req.bedrooms >= 5) warnings.push("5–6 bed stock is thin on lettings portals; also consider two adjacent smaller units.");

  return {
    request: req,
    geo,
    generatedAt: new Date().toISOString(),
    economics: econ,
    benchmark: bench,
    ons: ons ?? undefined,
    listings,
    sources: statuses,
    warnings,
  };
}

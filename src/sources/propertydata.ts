import type { Env, GeoPoint, Listing, MarketBenchmark, SearchRequest } from "../types";
import { num, parsePhone } from "../parse";

const BASE = "https://api.propertydata.co.uk";

function locParam(geo: GeoPoint): string {
  return geo.postcode ? `postcode=${encodeURIComponent(geo.postcode)}` : `location=${geo.lat},${geo.lng}`;
}

async function call(path: string, env: Env): Promise<any> {
  const r = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}key=${env.PROPERTYDATA_KEY}`, { signal: AbortSignal.timeout(20000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") throw new Error(`PropertyData ${path.split("?")[0]}: ${j.message || j.code || r.status}`);
  return j;
}

/** Live long-let asking-rent benchmark (aggregated from Rightmove/Zoopla/OTM by PropertyData). */
export async function rentBenchmark(req: SearchRequest, geo: GeoPoint, env: Env): Promise<MarketBenchmark> {
  const beds = Math.min(5, Math.max(0, req.bedrooms));
  const j = await call(`/rents?${locParam(geo)}&bedrooms=${beds}&points=40`, env);
  const ll = j?.data?.long_let ?? j?.data ?? {};
  const weekly = String(ll.unit || "gbp_per_week").includes("week");
  const toPcm = (v: unknown) => {
    const n = num(v);
    return n === undefined ? undefined : Math.round(weekly ? (n * 52) / 12 : n);
  };
  const range = ll["80pc_range"] || ll["70pc_range"];
  return {
    source: "PropertyData /rents (live asking rents)",
    bedrooms: beds,
    avgPcm: toPcm(ll.average),
    rangePcm: Array.isArray(range) ? [toPcm(range[0])!, toPcm(range[1])!] : undefined,
    pointsAnalysed: num(ll.points_analysed),
    radiusMiles: num(ll.radius),
    note: req.bedrooms > 5 ? "PropertyData caps bedrooms at 5; benchmark shown for 5-bed." : undefined,
  };
}

/** Rent-to-rent sourcing list: rental listings whose landlords/agents accept company lets / R2R. */
export async function rentToRent(req: SearchRequest, geo: GeoPoint, env: Env): Promise<Listing[]> {
  const radius = Math.max(1, Math.round(req.radiusMiles ?? 5));
  const j = await call(`/sourced-properties?list=rent-to-rent&${locParam(geo)}&radius=${radius}&results=60&exclude_sstc=1`, env);
  const rows: any[] = j?.properties ?? j?.data ?? j?.results ?? [];
  return rows.map((p, i): Listing => {
    const agent = p.agent ?? p.agent_name ?? p.agent_details;
    const agentName = typeof agent === "object" ? agent?.name ?? agent?.branch : agent;
    const agentPhone = (typeof agent === "object" ? agent?.phone ?? agent?.telephone : undefined) ?? p.agent_phone ?? parsePhone(String(agent ?? ""));
    const price = num(p.price ?? p.rent ?? p.asking_rent);
    const weekly = /week|pw/i.test(String(p.price_frequency ?? p.frequency ?? ""));
    return {
      id: `pd-${p.id ?? i}`,
      source: "propertydata",
      portal: p.portal ?? p.source ?? "PropertyData (rent-to-rent)",
      kind: "listing",
      title: p.title ?? `${p.bedrooms ?? "?"} bed ${p.type_standardised ?? p.type ?? "property"}`,
      address: p.address ?? [p.street, p.postcode].filter(Boolean).join(", "),
      bedrooms: num(p.bedrooms),
      bathrooms: num(p.bathrooms),
      rentPcm: price === undefined ? undefined : Math.round(weekly ? (price * 52) / 12 : price),
      rentRaw: p.price_display ?? (price !== undefined ? `£${price}` : undefined),
      agentName,
      agentPhone,
      agentEmail: typeof agent === "object" ? agent?.email : p.agent_email,
      url: p.url ?? p.listing_url ?? p.link,
      imageUrl: p.image_url,
      distanceMiles: num(p.distance_to ?? p.distance),
      lat: num(p.lat), lng: num(p.lng),
      snippet: Array.isArray(p.lists) ? `Lists: ${p.lists.join(", ")}` : undefined,
      score: 0,
      flags: ["rent-to-rent friendly"],
    };
  });
}

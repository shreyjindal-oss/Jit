import type { GeoPoint } from "./types";

const PC_FULL = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i;
const PC_OUT = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return null;
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

/** Nearest postcode for a lat/lng (to feed postcode-based APIs). */
type Admin = Pick<GeoPoint, "postcode" | "outcode" | "town" | "district" | "laCode" | "region" | "country">;
const admin = (p: any): Admin => ({
  postcode: p.postcode, outcode: p.outcode, town: p.admin_district,
  district: p.admin_district, laCode: p.codes?.admin_district, region: p.region ?? undefined, country: p.country,
});
async function reversePostcode(lat: number, lng: number): Promise<Admin> {
  const j = await getJson(`https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&limit=1&radius=2000`);
  const p = j?.result?.[0];
  return p ? admin(p) : {};
}

/** Geocode a UK postcode, outcode or place name. postcodes.io first, Nominatim fallback. */
export async function geocode(input: string): Promise<GeoPoint | null> {
  const q = input.trim();
  const full = q.replace(/\s+/g, "").match(PC_FULL);
  if (full) {
    const j = await getJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}`);
    const r = j?.result;
    if (r) return { lat: r.latitude, lng: r.longitude, label: `${r.postcode}, ${r.admin_district}`, ...admin(r) };
  }
  if (PC_OUT.test(q)) {
    const j = await getJson(`https://api.postcodes.io/outcodes/${encodeURIComponent(q)}`);
    const r = j?.result;
    if (r) {
      const rev = await reversePostcode(r.latitude, r.longitude); // for local-authority code / region
      return { lat: r.latitude, lng: r.longitude, label: `${r.outcode}, ${r.admin_district?.[0] ?? ""}`.replace(/, $/, ""), ...rev, postcode: r.outcode, outcode: r.outcode, town: r.admin_district?.[0] ?? rev.town };
    }
  }
  // Place name
  // postcodes.io matches on the place name only, so "Canary Wharf, London" -> retry with "Canary Wharf".
  // Place names repeat across the UK ("Kensington" is also in Liverpool), so honour qualifiers after the comma:
  // "Kensington, London" must pick a place whose region/county/borough mentions London.
  const quals = q.split(",").slice(1).map((x) => x.trim().toLowerCase()).filter((x) => x && !/^(uk|united kingdom|england|gb)$/.test(x));
  const fits = (p: any) => !quals.length || quals.some((w) => [p.region, p.county_unitary, p.district_borough, p.name_1, p.name_2, p.country].filter(Boolean).join(" ").toLowerCase().includes(w));
  let place: any;
  for (const term of [...new Set([q, q.split(",")[0].trim()])]) {
    const pj = await getJson(`https://api.postcodes.io/places?q=${encodeURIComponent(term)}&limit=20`).catch(() => null);
    place = (pj?.result ?? []).find(fits);
    if (place) break;
  }
  if (place?.latitude) {
    const rev = await reversePostcode(place.latitude, place.longitude);
    return { lat: place.latitude, lng: place.longitude, label: [place.name_1, place.county_unitary || place.district_borough].filter(Boolean).join(", "), ...rev, town: place.name_1 };
  }
  const nj = await getJson(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=${encodeURIComponent(q)}`,
    { headers: { "User-Agent": "thesqua.re-jit-inventory-sourcer/0.1" } },
  );
  const n = nj?.[0];
  if (n) {
    const lat = parseFloat(n.lat), lng = parseFloat(n.lon);
    const rev = await reversePostcode(lat, lng);
    return { lat, lng, label: n.display_name.split(",").slice(0, 3).join(","), ...rev };
  }
  return null;
}

export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/** URL slug for portal search pages, e.g. "Canary Wharf, London" -> "canary-wharf". */
export function slug(s: string): string {
  return s.toLowerCase().split(",")[0].trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Centre of a postcode district (cached per isolate). */
const ocCache = new Map<string, { lat: number; lng: number } | null>();
export async function outcodeCentre(oc: string): Promise<{ lat: number; lng: number } | null> {
  const k = oc.toUpperCase();
  if (ocCache.has(k)) return ocCache.get(k)!;
  const j = await getJson(`https://api.postcodes.io/outcodes/${encodeURIComponent(k)}`);
  const v = j?.result?.latitude ? { lat: j.result.latitude, lng: j.result.longitude } : null;
  ocCache.set(k, v);
  return v;
}

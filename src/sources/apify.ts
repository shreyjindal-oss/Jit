import type { Env, GeoPoint, Listing, SearchRequest } from "../types";
import { milesBetween, slug } from "../geo";
import { accessFit, detectAccess } from "../access";
import { FEATURE_LABEL, FEATURES, detectFeatures, detectType, type Feature, type PropType } from "../filters";
import { num, parseAvailable, parseBathrooms, parseBedrooms, parseFurnished, parseRentPcm } from "../parse";

/**
 * Rightmove, Zoopla, OnTheMarket + OpenRent RENTAL listings via Apify actors (run synchronously, in parallel).
 * Enabled by adding "apify" to ENABLED_SOURCES. Note: Rightmove's terms of use prohibit scraping.
 *
 * Defaults (override in wrangler.toml):
 *   APIFY_RIGHTMOVE_ACTOR = scrapesage~rightmove-scraper
 *   APIFY_ZOOPLA_ACTOR    = scrapesage~zoopla-scraper
 *   APIFY_OTM_ACTOR       = fatihtahta~onthemarket-scraper
 *   APIFY_OPENRENT_ACTOR  = vivid-softwares~openrent-property-scraper
 *   APIFY_PORTALS         = rightmove,zoopla,onthemarket,openrent
 *   APIFY_MAX_RESULTS     = 30   (per portal, per search)
 */

// Rightmove only accepts these radius values (miles).
const RM_RADII = [0, 0.25, 0.5, 1, 3, 5, 10, 15, 20, 30, 40];
const rmRadius = (r: number) => RM_RADII.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a)).toFixed(1);

function pick(o: any, ...keys: string[]): any {
  for (const k of keys) {
    const v = k.split(".").reduce((a, p) => (a == null ? a : a[p]), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

async function runActor(actor: string, input: unknown, env: Env, attempt = 0): Promise<any[]> {
  const r = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}&timeout=110&clean=1`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(130000) },
  );
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    // Apify plan caps concurrent actor runs; when several searches overlap, wait and retry (up to 3x).
    if (r.status === 402 && /concurrent-runs/.test(body) && attempt < 3) {
      await new Promise((res) => setTimeout(res, 8000 + attempt * 7000 + Math.random() * 4000));
      return runActor(actor, input, env, attempt + 1);
    }
    throw new Error(`Apify ${actor}: ${r.status} ${body}`);
  }
  const items = await r.json();
  return Array.isArray(items) ? items : [];
}

/** Rentals only: drop anything that looks like a sale listing. */
function isRental(it: any, priceText: string): boolean {
  const section = String(pick(it, "section", "channel", "transactionType", "searchType") ?? "").toLowerCase();
  if (/sale|buy/.test(section)) return false;
  if (/pcm|pw|per (?:month|week)|\/\s*(?:month|week)/i.test(priceText)) return true;
  const p = num(pick(it, "price", "price.amount")) ?? num(priceText.replace(/[^\d.]/g, ""));
  return !(p && p > 20000); // a bare amount above £20k is a sale price
}

type Portal = "Rightmove" | "Zoopla" | "OnTheMarket" | "OpenRent";

/** Photo URLs from any actor shape: string[], {url}[], {default,webp}[], plus single mainImage/imageUrl. */
function imagesOf(it: any, max = 12): string[] {
  const out: string[] = [];
  const add = (v: any) => {
    const u = typeof v === "string" ? v : v?.url ?? v?.default ?? v?.srcUrl ?? v?.src;
    if (typeof u === "string" && /^https?:\/\//.test(u) && !/staticMap|map_image|epc|floorplan/i.test(u) && !out.includes(u)) out.push(u.replace(":443/", "/"));
  };
  add(it.mainImage); add(it.imageUrl);
  for (const v of Array.isArray(it.images) ? it.images : []) add(v);
  for (const v of Array.isArray(it.propertyImages?.images) ? it.propertyImages.images : []) add(v);
  return out.slice(0, max);
}

/** First-listed date from the various actor fields ("Added on 12/09/2026", "Added today", ISO dates). */
function addedOn(it: any): string | undefined {
  const v = pick(it, "firstListedOn", "firstVisibleDate", "addedOn", "listingUpdate.listingUpdateDate", "publishedOn", "date_listed", "listed_date", "addedOrReduced");
  if (!v) return undefined;
  const s = String(v);
  if (/today/i.test(s)) return new Date().toISOString().slice(0, 10);
  if (/yesterday/i.test(s)) return new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (/reduced/i.test(s)) return undefined; // reduction date isn't the listing date
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const t = Date.parse(s);
  return isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** 850 / "850 sq ft" / "79 sq m" → sq ft */
function sqft(v: any): number | undefined {
  if (v == null || typeof v === "object") return undefined;
  const s = String(v).replace(/,/g, ""), n = parseFloat(s.replace(/[^\d.]/g, ""));
  if (!n) return undefined;
  return Math.round(/sq\.? ?m|m²|sqm/i.test(s) ? n * 10.764 : n);
}

const bool = (v: any) => (v === true || v === "true" || v === "yes" ? true : v === false || v === "false" || v === "no" ? false : undefined);

function normalise(it: any, portal: Portal, geo: GeoPoint, known: Partial<Record<Feature, boolean>> = {}): Listing | null {
  const priceText = String(
    pick(it, "displayPrice", "priceLabel", "price.displayPrices.0.displayPrice", "priceText") ??
      (typeof it.price === "string" ? it.price : "") ??
      "",
  );
  if (it.is_room_in_shared_house === true) return null; // OpenRent rooms
  if (!pick(it, "url", "propertyUrl", "link")) return null; // promo tiles / developer adverts with no listing page
  if (!isRental(it, priceText)) return null;
  let rent = num(it.price_pcm) ? { pcm: Math.round(num(it.price_pcm)!), raw: it.rent ? `${it.rent} pcm` : undefined } : parseRentPcm(priceText);
  if (!rent.pcm) {
    const p = num(pick(it, "price", "price.amount"));
    const freq = String(pick(it, "priceFrequency", "price.frequency", "frequency") ?? "monthly").toLowerCase();
    if (p) rent = { pcm: Math.round(/week/.test(freq) ? (p * 52) / 12 : p), raw: `£${p} ${/week/.test(freq) ? "pw" : "pcm"}` };
  }
  const title = String(pick(it, "title", "propertyTypeFullDescription", "summary") ?? `${portal} listing`);
  const desc = [pick(it, "description"), (pick(it, "keyFeatures", "features") ?? []).join?.(". ")].filter(Boolean).join(" ");
  const lat = num(pick(it, "latitude", "lat", "location_lat", "location.latitude"));
  const lng = num(pick(it, "longitude", "lng", "lon", "location_lon", "location.longitude"));
  const agent = [pick(it, "agentName", "agent_name"), pick(it, "agentBranch")].filter(Boolean).join(", ");
  // OpenRent: address is split (street / town / outcode) and the contact is the landlord, via OpenRent messaging.
  const address = portal === "OpenRent"
    ? [pick(it, "address"), pick(it, "location"), pick(it, "postcode")].filter(Boolean).join(", ") || title
    : pick(it, "displayAddress", "address");
  const flags: string[] = [];
  const features = [pick(it, "keyFeatures", "features", "highlights", "tags")].flat().filter((x: any) => typeof x === "string").join(". ");
  const access = detectAccess(title, pick(it, "summary"), pick(it, "description"), features, address, it.propertyType, it.propertySubType);
  const feats = detectFeatures([title, pick(it, "summary"), pick(it, "description"), features].filter(Boolean).join(" \n "), {
    // OpenRent exposes these as booleans; a portal-side filter guarantees them too.
    parking: known.parking ?? bool(pick(it, "parking", "has_parking", "parking_available")),
    pets: known.pets ?? bool(pick(it, "pets_allowed", "petsAllowed", "pets")),
    garden: known.garden ?? bool(pick(it, "garden", "has_garden")),
    bills_included: known.bills_included ?? bool(pick(it, "bills_included", "billsIncluded")),
  });
  const minTen = num(it.minimum_tenancy_months);
  if (minTen !== undefined) flags.push(`min tenancy ${minTen} mo`);
  if (portal === "OpenRent") flags.push("landlord-direct");
  return {
    id: `apify-${portal}-${pick(it, "listingId", "listing_id", "id", "propertyId", "url")}`,
    source: "apify",
    portal,
    kind: "listing",
    title,
    address,
    outcode: pick(it, "outcode") ?? (portal === "OpenRent" ? pick(it, "postcode") : undefined),
    bedrooms: num(pick(it, "bedrooms", "numBedrooms")) ?? (it.is_studio ? 0 : parseBedrooms(title)),
    bathrooms: num(pick(it, "bathrooms", "numBathrooms")) ?? parseBathrooms(title),
    rentPcm: rent.pcm,
    rentRaw: priceText || rent.raw,
    availableFrom: pick(it, "letAvailableDate", "availableFrom", "available_from", "available_from_date", "lettings.letAvailableDate") ?? parseAvailable(desc),
    furnished: pick(it, "furnishType", "furnishedState", "furnishing", "lettings.furnishType") ?? parseFurnished(`${title} ${desc}`),
    agentName: agent || pick(it, "agent.name", "branch.name") || (it.landlord_name ? `Landlord: ${it.landlord_name}` : portal === "OpenRent" ? "Landlord (message via OpenRent)" : undefined),
    agentPhone: pick(it, "agentPhone", "agent_phone", "agent.phone", "branch.phone", "customer.contactTelephone"),
    url: pick(it, "url", "propertyUrl", "link"),
    imageUrl: pick(it, "imageUrl", "mainImage", "images.0"),
    lat, lng,
    distanceMiles: lat !== undefined && lng !== undefined ? milesBetween(geo, { lat, lng }) : undefined,
    snippet: [pick(it, "addedOrReduced", "publishedOn", "days_on_market"), pick(it, "summary") ?? (desc ? desc.slice(0, 200) : undefined)].filter(Boolean).join(" · ") || undefined,
    score: 0,
    flags,
    minTenancyMonths: minTen,
    images: imagesOf(it),
    floor: access.floor,
    access: access.features,
    _access: access,
    _feat: feats,
    amenities: FEATURES.filter((f) => feats[f] === "yes").map((f) => FEATURE_LABEL[f]),
    propertyType: detectType(pick(it, "propertySubType", "propertyType", "property_type", "type_standardised"), title) ?? (it.is_studio ? "flat" : undefined),
    sizeSqFt: sqft(pick(it, "sizeSqFt", "size_sq_ft", "displaySize", "size")),
    addedOn: addedOn(it),
  } as Listing;
}

// OnTheMarket radius values (miles -> enum).
const OTM_RADII: [number, string][] = [[0, "this-area-only"], [0.25, "quarter-mile"], [0.5, "half-mile"], [1, "1-mile"], [2, "2-miles"], [3, "3-miles"], [4, "4-miles"], [5, "5-miles"], [7.5, "7-5-miles"], [10, "10-miles"], [15, "15-miles"], [20, "20-miles"], [30, "30-miles"], [40, "40-miles"]];
const otmRadius = (r: number) => OTM_RADII.reduce((a, b) => (Math.abs(b[0] - r) < Math.abs(a[0] - r) ? b : a))[1];

export async function apifyListings(req: SearchRequest, geo: GeoPoint, env: Env): Promise<Listing[]> {
  const max = parseInt(env.APIFY_MAX_RESULTS || "30", 10);
  const opts = req.bedroomOptions?.length ? req.bedroomOptions : [req.bedrooms];
  const minBeds = Math.min(...opts), maxBeds = Math.max(...opts);
  const radius = req.radiusMiles ?? 3;
  const place = req.location.split(",")[0].trim();
  const isPostcode = /^[A-Z]{1,2}\d/i.test(place);
  const must = new Set(req.mustHave ?? []);
  // Accessibility / must-haves are read from the description + key features, so detail pages are fetched (slower).
  const needsText = (!!req.accessibility && req.accessibility !== "any") || !!req.accessNeeds?.length || must.size > 0;
  const portals = new Set((env.APIFY_PORTALS || "rightmove,zoopla,onthemarket,openrent").split(",").map((s) => s.trim().toLowerCase()));
  const types = new Set<PropType>(req.propertyTypes ?? []);
  const price = { ...(req.minRentPcm ? { minPrice: req.minRentPcm } : {}), ...(req.maxRentPcm ? { maxPrice: req.maxRentPcm } : {}) };
  const one = <T,>(m: Record<PropType, T>): T | undefined => { const v = [...new Set([...types].map((t) => m[t]))]; return v.length === 1 ? v[0] : undefined; };

  const rightmove = async () => {
    const rmTypes = [...types].flatMap((t) => (t === "flat" ? ["flat"] : t === "house" ? ["detached", "semi-detached", "terraced"] : ["bungalow"]));
    const rmFurn = (req.furnishing ?? []).map((f) => (f === "part_furnished" ? "partFurnished" : f));
    const days = req.addedWithinDays ? String([1, 3, 7, 14].find((d) => d >= req.addedWithinDays!) ?? "") : "";
    const items = await runActor(env.APIFY_RIGHTMOVE_ACTOR || "scrapesage~rightmove-scraper", {
      searchType: "to-rent",
      locations: [isPostcode && geo.outcode ? geo.outcode : place],
      minBedrooms: minBeds, maxBedrooms: maxBeds,
      ...price,
      ...(rmTypes.length ? { propertyTypes: rmTypes } : {}),
      ...(rmFurn.length ? { furnishTypes: rmFurn } : {}),
      ...(days ? { maxDaysSinceAdded: days } : {}),
      radius: rmRadius(radius),
      includeLetAgreed: false,
      // Detail pages add furnish type / let-available date / key features but make runs ~3x slower.
      includePropertyDetails: env.APIFY_RM_DETAILS === "true" || needsText,
      maxResults: max,
    }, env);
    return items.filter((i) => (i.type ?? "property") === "property").map((i) => normalise(i, "Rightmove", geo)).filter(Boolean) as Listing[];
  };

  const zoopla = async () => {
    const actor = env.APIFY_ZOOPLA_ACTOR || "scrapesage~zoopla-scraper";
    const zType = one<string>({ flat: "flats", house: "houses", bungalow: "bungalows" });
    const base = {
      section: "to-rent", minBeds, maxBeds, ...price,
      ...(zType ? { propertyType: zType } : {}),
      ...(req.bathrooms ? { minBaths: req.bathrooms } : {}),
      ...(req.minSizeSqFt ? { minSizeSqFt: req.minSizeSqFt } : {}),
      ...(req.addedWithinDays ? { sort: "newest_listings" } : {}),
      excludeUnderOffer: true,
      includeDetails: needsText, maxPagesPerLocation: Math.max(1, Math.ceil(max / 25)),
    };
    // Zoopla wants its own location slug; try the area, then fall back to the wider town/outcode.
    const candidates = [...new Set([isPostcode && geo.outcode ? geo.outcode.toLowerCase() : slug(place), geo.town ? slug(geo.town) : ""].filter(Boolean))];
    for (const loc of candidates) {
      const items = await runActor(actor, { ...base, locations: [loc] }, env);
      const ls = items.map((i) => normalise(i, "Zoopla", geo)).filter(Boolean) as Listing[];
      if (ls.length) return ls.slice(0, max);
    }
    return [];
  };

  const onthemarket = async () => {
    const otmTypes = [...types].flatMap((t) => (t === "flat" ? ["flats-apartments"] : t === "house" ? ["detached", "semi-detached", "terraced"] : ["bungalows"]));
    const added = req.addedWithinDays === 1 ? "24-hours" : req.addedWithinDays === 3 ? "3-days" : req.addedWithinDays === 7 ? "7-days" : undefined;
    const items = await runActor(env.APIFY_OTM_ACTOR || "fatihtahta~onthemarket-scraper", {
      queries: [isPostcode && geo.outcode ? geo.outcode : place],
      type: "rentals",
      minBedrooms: minBeds, maxBedrooms: maxBeds,
      ...price,
      ...(otmTypes.length ? { propertyTypes: otmTypes } : {}),
      ...(added ? { addedToSite: added } : {}),
      radius: otmRadius(radius),
      limit: Math.max(10, max), // actor minimum is 10
    }, env);
    return items.map((i) => normalise(i, "OnTheMarket", geo)).filter(Boolean) as Listing[];
  };

  const openrent = async () => {
    const orType = one<string>({ flat: "flats", house: "houses", bungalow: "houses" });
    const f = req.furnishing ?? [];
    const orFurn = f.length === 1 && f[0] !== "part_furnished" ? f[0] : undefined;
    const known: Partial<Record<Feature, boolean>> = {};
    for (const k of ["parking", "pets", "garden", "bills_included"] as Feature[]) if (must.has(k)) known[k] = true;
    const items = await runActor(env.APIFY_OPENRENT_ACTOR || "vivid-softwares~openrent-property-scraper", {
      inputMode: "url_builder",
      search_location: isPostcode && geo.outcode ? geo.outcode : place,
      search_bedrooms_min: minBeds, search_bedrooms_max: maxBeds,
      ...(req.bathrooms ? { search_bathrooms_min: req.bathrooms } : {}),
      ...(req.minRentPcm ? { search_min_price: req.minRentPcm } : {}),
      ...(req.maxRentPcm ? { search_max_price: req.maxRentPcm } : {}),
      ...(orFurn ? { search_furnishing: orFurn } : {}),
      ...(orType ? { search_property_type: orType } : {}),
      ...(must.has("pets") ? { search_pets_allowed: true } : {}),
      ...(must.has("parking") ? { search_parking: true } : {}),
      ...(must.has("garden") ? { search_garden: true } : {}),
      ...(must.has("bills_included") ? { search_bills_included: true } : {}),
      ...(req.addedWithinDays ? { search_sort_by: "newest" } : {}),
      search_radius_km: Math.max(1, Math.round(radius * 1.609)),
      onlyAvailableProperties: true,
      scrapeDetails: true, // needed for address, landlord name, deposit, EPC
      includeImages: true,
      reportDelisted: false,
      includeDuplicates: true,
      maxItems: Math.min(max, Number(env.APIFY_OPENRENT_MAX || 10)), // ~$0.015 per listing — capped (default 10)
    }, env);
    return items.map((i) => normalise(i, "OpenRent", geo, known)).filter(Boolean) as Listing[];
  };

  const jobs: [string, () => Promise<Listing[]>][] = [["rightmove", rightmove], ["zoopla", zoopla], ["onthemarket", onthemarket], ["openrent", openrent]];
  const active = jobs.filter(([k]) => portals.has(k));
  const settled = await Promise.allSettled(active.map(([, fn]) => fn()));
  const out: Listing[] = [];
  const errors: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(...r.value);
    else errors.push(`${active[i][0]}: ${String((r as any).reason?.message ?? (r as any).reason).slice(0, 200)}`);
  });
  if (!out.length && errors.length) throw new Error(errors.join(" | "));
  (out as any).errors = errors; // partial failure (one portal down) -> surfaced as a warning
  (out as any).perPortal = Object.fromEntries(active.map(([k], i) => [k, settled[i].status === "fulfilled" ? (settled[i] as any).value.length : "error"]));
  return out;
}

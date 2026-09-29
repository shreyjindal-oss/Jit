/**
 * Search filters shared by the pipeline, portals, alerts and emails.
 *
 * What each portal can filter on natively (Apify actor inputs, checked Sep 2026):
 *   Rightmove   beds range, price range, propertyTypes[], furnishTypes[], maxDaysSinceAdded, radius, includeLetAgreed
 *   Zoopla      beds range, price range, minBaths, minSizeSqFt, propertyType (one), excludeUnderOffer, sort newest
 *   OnTheMarket beds range, price range, propertyTypes[], addedToSite, radius
 *   OpenRent    beds range, price range, min baths, property type (one), furnishing (one), pets, parking, garden,
 *               bills included, sort newest
 * Anything a portal can't filter on (e.g. parking on Rightmove) is read from the listing text and
 * checked afterwards: clear "no" → dropped, not stated → kept and flagged (or dropped in strict mode).
 */

export type Furnishing = "furnished" | "part_furnished" | "unfurnished";
export type PropType = "flat" | "house" | "bungalow";
export type Feature = "parking" | "pets" | "garden" | "balcony" | "bills_included";
export type Tri = "yes" | "no" | "unknown";

export const FURNISHINGS: Furnishing[] = ["furnished", "part_furnished", "unfurnished"];
export const PROP_TYPES: PropType[] = ["flat", "house", "bungalow"];
export const FEATURES: Feature[] = ["parking", "pets", "garden", "balcony", "bills_included"];
export const FEATURE_LABEL: Record<Feature, string> = {
  parking: "parking", pets: "pets allowed", garden: "garden", balcony: "balcony/terrace", bills_included: "bills included",
};
export const ADDED_WITHIN = [1, 3, 7, 14];

/** Accepts an array, "a,b", "a; b" or a single value → cleaned, de-duplicated list of allowed values. */
export function listOf<T extends string>(v: unknown, allowed: readonly T[], alias: Record<string, T> = {}): T[] {
  const raw = Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(/[,;|/]+/);
  const out: T[] = [];
  for (const x of raw) {
    const k = String(x).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const val = (allowed as readonly string[]).includes(k) ? (k as T) : alias[k];
    if (val && !out.includes(val)) out.push(val);
  }
  return out;
}

export const FURNISH_ALIAS: Record<string, Furnishing> = { part: "part_furnished", partfurnished: "part_furnished", part_furnished: "part_furnished", partly_furnished: "part_furnished", yes: "furnished", no: "unfurnished" };
export const TYPE_ALIAS: Record<string, PropType> = { flats: "flat", apartment: "flat", apartments: "flat", studio: "flat", maisonette: "flat", houses: "house", detached: "house", semi_detached: "house", terraced: "house", townhouse: "house", cottage: "house", bungalows: "bungalow" };
export const FEATURE_ALIAS: Record<string, Feature> = { pet: "pets", pets_allowed: "pets", pet_friendly: "pets", car_parking: "parking", garage: "parking", bills: "bills_included", bills_inc: "bills_included", terrace: "balcony", outdoor_space: "balcony", balconies: "balcony", gardens: "garden" };

/** Classify a portal furnish value ("Furnished or unfurnished, landlord is flexible", "Part furnished", …). */
export function furnishClass(v?: string): Furnishing | "flexible" | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (/flexible|or unfurnished|furnished or|optional/.test(s)) return "flexible";
  if (/part/.test(s)) return "part_furnished";
  if (/unfurn/.test(s)) return "unfurnished";
  if (/furn/.test(s)) return "furnished";
  return undefined;
}

/** Property type from portal fields / title. */
export function detectType(...texts: (string | undefined | null)[]): PropType | undefined {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return undefined;
  if (/\bbungalow/.test(t)) return "bungalow";
  if (/\b(?:flat|apartment|studio|maisonette|penthouse|duplex|flats)\b/.test(t)) return "flat";
  if (/\b(?:house|detached|semi[- ]detached|terraced|end of terrace|town ?house|cottage|mews|villa)\b/.test(t)) return "house";
  return undefined;
}

const FEAT_RE: Record<Feature, { yes: RegExp; no?: RegExp }> = {
  parking: {
    yes: /\b(?:off[- ]street|allocated|private|secure|underground|gated|residents'?|permit|on[- ]site|car) parking\b|\bparking (?:space|bay|available|included|permit)s?\b|\bgarage\b|\bdriveway\b|\bcar ?port\b|\bparking\b/i,
    no: /\bno (?:off[- ]street |allocated |on[- ]site )?parking\b|\bparking (?:is )?not (?:available|included|provided)\b|\bwithout parking\b/i,
  },
  pets: {
    yes: /\bpets? (?:are )?(?:allowed|considered|friendly|welcome|accepted|ok|permitted)\b|\bpet[- ]friendly\b|\b(?:dogs?|cats?) (?:are )?(?:allowed|considered|welcome|accepted)\b|\bpets? (?:by|on) (?:negotiation|request)\b/i,
    no: /\bno (?:pets|dogs|animals)\b|\bpets? (?:are )?not (?:allowed|permitted|accepted|considered)\b|\bstrictly no pets\b|\bunsuitable for pets\b/i,
  },
  garden: {
    yes: /\b(?:private|rear|front|communal|shared|south[- ]facing|west[- ]facing|east[- ]facing|north[- ]facing|landscaped|enclosed|own|large|lovely|beautiful|mature|patio|secluded|walled) gardens?\b|\bgarden (?:flat|apartment|access|space)\b|\b(?:with|access to) (?:a |the )?(?:private |communal |shared )?gardens?\b|\bgardens? to (?:the )?(?:rear|front)\b/i,
  },
  balcony: { yes: /\bbalcon(?:y|ies)\b|\b(?:roof|private|sun|own|large|wrap[- ]around|south[- ]facing|decked) terrace\b|\broof ?terrace\b|\bpatio\b|\bwinter garden\b|\bjuliet\b/i },
  bills_included: {
    yes: /\bbills? (?:are )?included\b|\ball bills\b|\ball[- ]inclusive\b|\binclusive of (?:all )?(?:bills|utilities)\b|\butilities (?:are )?included\b/i,
    no: /\bbills? (?:are )?(?:not included|excluded|extra)\b|\bexclusive of bills\b/i,
  },
};

/** Tri-state feature detection from listing text; `known` (portal booleans) wins when present. */
export function detectFeatures(text: string, known: Partial<Record<Feature, boolean | undefined>> = {}): Record<Feature, Tri> {
  const t = text.replace(/\s+/g, " ");
  const out = {} as Record<Feature, Tri>;
  for (const f of FEATURES) {
    const k = known[f];
    if (k === true) out[f] = "yes";
    else if (FEAT_RE[f].no?.test(t)) out[f] = "no";
    else if (FEAT_RE[f].yes.test(t)) out[f] = "yes";
    else if (k === false) out[f] = "no";
    else out[f] = "unknown";
  }
  return out;
}

const bedWord = (b: number) => (b === 0 ? "Studio" : `${b} bed`);
/** "2 bed", "2–3 bed", "Studio, 1 bed" */
export function bedsLabel(req: { bedrooms: number; bedroomOptions?: number[] }): string {
  const o = req.bedroomOptions?.length ? [...req.bedroomOptions].sort((a, b) => a - b) : [req.bedrooms];
  if (o.length === 1) return bedWord(o[0]);
  const contiguous = o.every((b, i) => i === 0 || b === o[i - 1] + 1);
  if (contiguous && o[0] > 0) return `${o[0]}–${o[o.length - 1]} bed`;
  return o.map(bedWord).join(", ");
}

/** Short human summary of the non-bed filters (for emails / alert list). */
export function filtersSummary(req: any): string {
  const acc = (req.accessNeeds?.length ? req.accessNeeds : req.accessibility && req.accessibility !== "any" ? [req.accessibility] : []) as string[];
  return [
    req.propertyTypes?.length ? req.propertyTypes.join("/") : "",
    req.minRentPcm || req.maxRentPcm ? `${req.minRentPcm ? "£" + req.minRentPcm : ""}${req.minRentPcm && req.maxRentPcm ? "–" : ""}${req.maxRentPcm ? (req.minRentPcm ? "" : "max ") + "£" + req.maxRentPcm : "+"} pcm` : "",
    req.furnishing?.length ? req.furnishing.map((f: string) => f.replace("_", " ")).join("/") : req.furnished && req.furnished !== "any" ? req.furnished : "",
    req.bathrooms ? `${req.bathrooms}+ bath` : "",
    req.minSizeSqFt ? `${req.minSizeSqFt}+ sq ft` : "",
    ...acc.map((a) => a.replace("_", " ")),
    ...((req.mustHave ?? []) as Feature[]).map((f) => FEATURE_LABEL[f] ?? f),
    req.addedWithinDays ? `added ≤${req.addedWithinDays}d` : "",
    req.strict ? "confirmed only" : "",
  ].filter(Boolean).join(" · ");
}

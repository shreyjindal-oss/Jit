export interface Env {
  // Secrets (.dev.vars locally, `wrangler secret put` in prod)
  PROPERTYDATA_KEY?: string;
  APIFY_TOKEN?: string;
  ACCESS_TOKEN?: string; // optional shared token to gate the API/UI

  // Vars (wrangler.toml)
  ENABLED_SOURCES?: string; // csv: apify,propertydata
  DEFAULT_RADIUS_MILES?: string;
  MIN_LEASE_MONTHS?: string;
  APIFY_RIGHTMOVE_ACTOR?: string;
  APIFY_ZOOPLA_ACTOR?: string;
  APIFY_OTM_ACTOR?: string;
  APIFY_OPENRENT_ACTOR?: string;
  APIFY_OPENRENT_MAX?: string; // OpenRent results per search (cost: ~$0.015 each)
  SENDGRID_API_KEY?: string; // alerts email
  ALERT_FROM_EMAIL?: string; // default noreply@thesqua.re
  ALERT_EMAIL_DOMAINS?: string; // csv of allowed recipient domains
  MAX_ACTIVE_ALERTS?: string;
  MAX_ALERTS_PER_EMAIL?: string;
  PUBLIC_URL?: string; // for links in emails
  APIFY_PORTALS?: string; // csv: rightmove,zoopla,onthemarket,openrent
  ONS_KV?: KVNamespace; // ONS average rents, refreshed monthly by the cron trigger
  APIFY_MAX_RESULTS?: string; // per portal per search
  APIFY_RM_DETAILS?: string; // "true" = open each Rightmove listing (slower, adds furnished/available date)
  DB?: D1Database; // saved searches, results, bulk uploads
  MAX_SEARCHES_PER_DAY?: string; // cost guard (UI + bulk combined)
  MAX_BATCH_ROWS?: string; // cost guard per uploaded sheet
  BATCH_CONCURRENCY?: string; // rows processed per cron tick
}

export interface SearchRequest {
  location: string; // postcode, area, or city
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  bedrooms: number; // 0 = studio, 1..6
  bathrooms?: number; // minimum
  beds?: number; // number of beds needed (informational; portals don't filter on it)
  maxRentPcm?: number;
  furnished?: "any" | "furnished" | "unfurnished";
  radiusMiles?: number;
  sellRateNightly?: number; // our nightly sell rate to the client, for margin estimate
  setupCost?: number; // furnishing / onboarding one-off cost estimate
  clientAccount?: string;
  enquiryRef?: string;
  accessibility?: import("./access").AccessNeed; // first selected need (kept for DB/back-compat)
  // Multi-select filters (empty/undefined = any)
  bedroomOptions?: number[]; // e.g. [2,3]; bedrooms = the smallest
  furnishing?: import("./filters").Furnishing[];
  propertyTypes?: import("./filters").PropType[];
  accessNeeds?: import("./access").AccessNeed[]; // all must be met
  mustHave?: import("./filters").Feature[]; // all must be met
  minRentPcm?: number;
  minSizeSqFt?: number;
  addedWithinDays?: number; // 1 | 3 | 7 | 14
  strict?: boolean; // drop listings that don't state a required feature/access (default: keep + flag)
}

export type SourceId = "propertydata" | "apify";

export interface Listing {
  id: string;
  source: SourceId;
  portal: string; // Rightmove, Zoopla, OpenRent, OnTheMarket, PropertyData, ...
  kind: "listing" | "search_page";
  title: string;
  address?: string;
  bedrooms?: number;
  bathrooms?: number;
  rentPcm?: number;
  rentRaw?: string;
  availableFrom?: string;
  furnished?: string;
  agentName?: string;
  agentPhone?: string;
  agentEmail?: string;
  url?: string;
  imageUrl?: string;
  distanceMiles?: number;
  outcode?: string; // postcode district parsed from the listing text
  lat?: number;
  lng?: number;
  snippet?: string;
  minTenancyMonths?: number; // OpenRent: landlord's minimum tenancy
  images?: string[]; // photo URLs (portal CDNs), first = main
  floor?: string; // detected floor ("Ground", "3rd", "Bungalow", …)
  access?: string[]; // detected accessibility signals
  accessFit?: "fit" | "unknown" | "no";
  propertyType?: string; // flat | house | bungalow (detected)
  amenities?: string[]; // detected: parking, pets allowed, garden, balcony/terrace, bills included
  sizeSqFt?: number;
  addedOn?: string; // first listed (ISO) when the portal gives it
  score: number; // 0..100 match score
  flags: string[];
}

export interface MarketBenchmark {
  source: string;
  bedrooms: number;
  avgPcm?: number;
  rangePcm?: [number, number];
  pointsAnalysed?: number;
  radiusMiles?: number;
  note?: string;
}

export interface Economics {
  nights: number;
  stayMonths: number;
  leaseMonths: number;
  leaseExceedsStay: boolean;
  voidMonths: number;
  benchmarkRentPcm?: number;
  leaseCost?: number; // rent * leaseMonths + setup
  breakEvenNightlyStayOnly?: number; // lease cost / nights of this stay
  revenue?: number;
  margin?: number;
  marginPct?: number;
  notes: string[];
}

export interface SourceStatus {
  source: SourceId | "geocode" | "ons";
  ok: boolean;
  count?: number;
  skipped?: string;
  error?: string;
  ms?: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
  postcode?: string; // full or outcode
  outcode?: string;
  town?: string;
  district?: string; // local authority name (postcodes.io admin_district)
  laCode?: string; // local authority GSS code, e.g. E09000030
  region?: string;
  country?: string;
}

export interface SearchResponse {
  request: SearchRequest;
  geo?: GeoPoint;
  generatedAt: string;
  economics: Economics;
  benchmark?: MarketBenchmark;
  ons?: import("./ons").OnsBenchmark;
  listings: Listing[];
  sources: SourceStatus[];
  warnings: string[];
}

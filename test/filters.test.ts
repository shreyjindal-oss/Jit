// Multi-select filters: validation, feature/type detection, filtering, portal inputs, batch parsing.
import assert from "node:assert/strict";
import { validate, rankAndFilter } from "../src/pipeline";
import { detectFeatures, detectType, bedsLabel, furnishClass, filtersSummary } from "../src/filters";
import { rowsToBodies } from "../src/batch";
import { apifyListings } from "../src/sources/apify";

const base = { location: "E14", checkIn: "2026-11-01", checkOut: "2027-02-01" };

// --- validate
let v = validate({ ...base, bedrooms: ["3", "2"], furnishing: ["furnished", "part_furnished"], propertyTypes: "flat,house", accessNeeds: ["ground_floor", "wheelchair"], mustHave: ["parking", "pets"], minRentPcm: "1500", maxRentPcm: "3000", addedWithinDays: "7", strict: true }).req!;
assert.deepEqual(v.bedroomOptions, [2, 3]); assert.equal(v.bedrooms, 2);
assert.deepEqual(v.furnishing, ["furnished", "part_furnished"]); assert.equal(v.furnished, "any");
assert.deepEqual(v.propertyTypes, ["flat", "house"]); assert.deepEqual(v.accessNeeds, ["ground_floor", "wheelchair"]); assert.equal(v.accessibility, "ground_floor");
assert.deepEqual(v.mustHave, ["parking", "pets"]); assert.equal(v.addedWithinDays, 7); assert.equal(v.strict, true); assert.equal(v.minRentPcm, 1500);
assert.equal(bedsLabel(v), "2–3 bed"); assert.equal(bedsLabel({ bedrooms: 0, bedroomOptions: [0, 1] }), "Studio, 1 bed");
v = validate({ ...base, bedrooms: 2, furnished: "furnished", accessibility: "step_free" }).req!; // legacy single values still work
assert.equal(v.bedroomOptions, undefined); assert.deepEqual(v.furnishing, ["furnished"]); assert.equal(v.furnished, "furnished"); assert.deepEqual(v.accessNeeds, ["step_free"]);
assert.equal(validate({ ...base, bedrooms: [] }).error, "bedrooms must be 0 (studio) to 6");
assert.match(validate({ ...base, bedrooms: 2, minRentPcm: 3000, maxRentPcm: 2000 }).error!, /min rent/);
assert.equal(validate({ ...base, bedrooms: 2, propertyTypes: ["flat", "house", "bungalow"] }).req!.propertyTypes, undefined); // all = any
assert.match(filtersSummary(validate({ ...base, bedrooms: 2, mustHave: "parking", accessibility: "wheelchair" }).req!), /wheelchair · parking/);

// --- detection
let f = detectFeatures("Allocated parking. Pets considered. Private rear garden, balcony. All bills included.");
assert.deepEqual(f, { parking: "yes", pets: "yes", garden: "yes", balcony: "yes", bills_included: "yes" });
f = detectFeatures("Sorry, no pets. No parking. Close to Covent Garden. Terraced house. Bills not included.");
assert.deepEqual(f, { parking: "no", pets: "no", garden: "unknown", balcony: "unknown", bills_included: "no" });
assert.equal(detectFeatures("lovely flat", { pets: true }).pets, "yes");
assert.equal(detectType("Flat", "2 bed apartment"), "flat"); assert.equal(detectType("Semi-Detached"), "house"); assert.equal(detectType("Detached bungalow"), "bungalow");
assert.equal(furnishClass("Furnished or unfurnished, landlord is flexible"), "flexible"); assert.equal(furnishClass("Part furnished"), "part_furnished"); assert.equal(furnishClass("Unfurnished"), "unfurnished");

// --- rankAndFilter
const L = (o: any) => ({ id: Math.random() + "", source: "apify", portal: "Rightmove", kind: "listing", title: "x", score: 0, flags: [], url: "https://r/" + Math.random(), ...o });
const req = validate({ ...base, bedrooms: [2, 3], propertyTypes: ["flat"], furnishing: ["furnished"], mustHave: ["parking"], minRentPcm: 1500 }).req!;
const feat = (p: string) => detectFeatures(p);
const out = rankAndFilter([
  L({ bedrooms: 2, propertyType: "flat", furnished: "Furnished", rentPcm: 2000, _feat: feat("underground parking"), amenities: ["parking"], address: "keep-yes" }),
  L({ bedrooms: 3, propertyType: "flat", rentPcm: 2000, _feat: feat("nice flat"), address: "keep-unknown" }),
  L({ bedrooms: 4, propertyType: "flat", rentPcm: 2000, address: "drop-beds" }),
  L({ bedrooms: 2, propertyType: "house", rentPcm: 2000, address: "drop-type" }),
  L({ bedrooms: 2, propertyType: "flat", furnished: "Unfurnished", rentPcm: 2000, address: "drop-furn" }),
  L({ bedrooms: 2, propertyType: "flat", rentPcm: 2000, _feat: feat("no parking"), address: "drop-noparking" }),
  L({ bedrooms: 2, propertyType: "flat", rentPcm: 1200, address: "drop-cheap" }),
  L({ bedrooms: 2, furnished: "Furnished or unfurnished", rentPcm: 2000, _feat: feat("parking"), address: "keep-flexible" }),
] as any, req);
assert.deepEqual(out.map((l) => l.address).sort(), ["keep-flexible", "keep-unknown", "keep-yes"]);
assert.ok(out.find((l) => l.address === "keep-unknown")!.flags.includes("parking not stated — check"));
assert.ok(out.find((l) => l.address === "keep-yes")!.flags.includes("parking ✓"));
assert.equal(out[0].address === "keep-unknown", false); // confirmed listings rank above unknowns
const strict = rankAndFilter([L({ bedrooms: 2, propertyType: "flat", furnished: "Furnished", rentPcm: 2000, _feat: feat("nice") })] as any, { ...req, strict: true });
assert.equal(strict.length, 0);

// --- portal inputs
const calls: any[] = [];
globalThis.fetch = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("[]", { status: 200 }); }) as any;
await apifyListings(validate({ ...base, bedrooms: [2, 3], propertyTypes: ["house"], furnishing: ["part_furnished"], mustHave: ["pets", "parking"], addedWithinDays: 3, minRentPcm: 1000, bathrooms: 2, minSizeSqFt: 700 }).req!, { lat: 51.5, lng: 0, label: "E14", outcode: "E14", town: "London" }, { APIFY_TOKEN: "t" } as any).catch(() => []);
const by = (a: string) => calls.find((c) => c.url.includes(a))!.body;
const rm = by("rightmove"), zp = by("zoopla"), otm = by("onthemarket"), or = by("openrent");
assert.deepEqual([rm.minBedrooms, rm.maxBedrooms, rm.minPrice], [2, 3, 1000]); assert.deepEqual(rm.propertyTypes, ["detached", "semi-detached", "terraced"]);
assert.deepEqual(rm.furnishTypes, ["partFurnished"]); assert.equal(rm.maxDaysSinceAdded, "3"); assert.equal(rm.includePropertyDetails, true);
assert.deepEqual([zp.minBeds, zp.maxBeds, zp.propertyType, zp.minBaths, zp.minSizeSqFt, zp.sort], [2, 3, "houses", 2, 700, "newest_listings"]);
assert.deepEqual([otm.addedToSite, otm.propertyTypes.length], ["3-days", 3]);
assert.deepEqual([or.search_pets_allowed, or.search_parking, or.search_property_type, or.search_furnishing, or.search_bedrooms_max], [true, true, "houses", undefined, 3]);

// --- batch
const b = rowsToBodies([{ Location: "M1", "Check in": "2026-11-01", "Check out": "2027-01-01", Bedrooms: "2-3 bed", "Property type": "house;bungalow", Furnished: "part furnished; unfurnished", Accessibility: "ground floor, wheelchair", "Must have": "parking; pets" }]);
assert.deepEqual([b[0].bedrooms, b[0].propertyTypes, b[0].furnishing, b[0].accessNeeds, b[0].mustHave], ["2,3", "house;bungalow", "part_furnished,unfurnished", "wheelchair,ground_floor", "parking; pets"]);
const vb = validate(b[0]).req!;
assert.deepEqual([vb.bedroomOptions, vb.propertyTypes, vb.furnishing, vb.mustHave], [[2, 3], ["house", "bungalow"], ["part_furnished", "unfurnished"], ["parking", "pets"]]);
console.log("FILTERS OK");

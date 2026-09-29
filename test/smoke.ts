// Offline smoke test: mocks all outbound HTTP and runs the full pipeline. `npm test`
import assert from "node:assert/strict";
import { parseBedrooms, parseRentPcm, parseBathrooms, parseAvailable } from "../src/parse";
import { validate, runSearch } from "../src/pipeline";
import worker from "../src/index";

// --- parsers
assert.equal(parseRentPcm("£2,450 pcm").pcm, 2450);
assert.equal(parseRentPcm("£600 pw").pcm, 2600);
assert.equal(parseRentPcm("£450,000 guide price").pcm, undefined);
assert.equal(parseBedrooms("2 bedroom flat to rent"), 2);
assert.equal(parseBedrooms("Studio to rent in E14"), 0);
assert.equal(parseBathrooms("2 bed, 2 bath apartment"), 2);
assert.equal(parseAvailable("Available from 12th October 2026"), "12th October 2026");
assert.equal(validate({ location: "E14", checkIn: "2026-10-10", checkOut: "2026-10-01", bedrooms: 2 }).error, "checkOut must be after checkIn");
assert.equal(validate({ location: "E14", checkIn: "2026-10-01", checkOut: "2026-10-10", bedrooms: 7 }).error, "bedrooms must be 0 (studio) to 6");

// --- mock fetch
const calls: string[] = [];
(globalThis as any).fetch = async (input: any) => {
  const url = String(input.url ?? input);
  calls.push(url);
  const j = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  if (url.includes("postcodes.io/places")) return j({ result: [{ name_1: "Canary Wharf", county_unitary: "Greater London", latitude: 51.5054, longitude: -0.0235 }] });
  if (url.includes("postcodes.io/outcodes/E14")) return j({ result: { latitude: 51.5, longitude: -0.02 } });
  if (url.includes("postcodes.io/outcodes/IG11")) return j({ result: { latitude: 51.536, longitude: 0.08 } });
  if (url.includes("postcodes.io/postcodes?")) return j({ result: [{ postcode: "E14 5AB", outcode: "E14", admin_district: "Tower Hamlets" }] });
  if (url.includes("propertydata.co.uk/rents")) return j({ status: "success", data: { long_let: { unit: "gbp_per_week", average: 700, "80pc_range": [600, 820], points_analysed: 40, radius: "0.5" } } });
  if (url.includes("sourced-properties")) return j({ status: "success", properties: [
    { id: 1, address: "Westferry Circus, E14", bedrooms: 2, bathrooms: 2, price: 3000, type_standardised: "Flat", agent: { name: "Dockside Lettings", phone: "020 7123 4567" }, url: "https://www.rightmove.co.uk/properties/111", distance_to: 0.4, lists: ["Rent to rent"] },
    { id: 2, address: "Far Away", bedrooms: 3, price: 2800 },
  ] });
  throw new Error("unexpected fetch " + url);
};

const env = { PROPERTYDATA_KEY: "y", ENABLED_SOURCES: "propertydata", MIN_LEASE_MONTHS: "6" };
const { req } = validate({ location: "Canary Wharf, London", checkIn: "2026-10-12", checkOut: "2027-01-10", bedrooms: 2, bathrooms: 2, furnished: "furnished", maxRentPcm: 3500, radiusMiles: 1, sellRateNightly: 175, setupCost: 1500 });
const res = await runSearch(req!, env);
assert.equal(res.geo?.outcode, "E14");
assert.equal(res.benchmark?.avgPcm, 3033); // £700 pw -> pcm
const ls = res.listings;
assert.ok(!ls.some((l) => l.bedrooms === 3), "wrong bed counts filtered");
assert.equal(ls[0].agentPhone, "020 7123 4567");
assert.equal(res.economics.nights, 90);
assert.equal(res.economics.leaseMonths, 6);
assert.ok(res.economics.leaseExceedsStay);
assert.ok(!("lettingAgents" in res) && !("portalLinks" in res), "agents + portal links removed");

// --- worker routes
const html = await worker.fetch(new Request("http://x/"), env as any);
assert.equal(html.status, 200);
const bad = await worker.fetch(new Request("http://x/api/search", { method: "POST", body: "{}" }), env as any);
assert.equal(bad.status, 400);
const gated = await worker.fetch(new Request("http://x/api/search?location=E14"), { ...env, ACCESS_TOKEN: "t" } as any);
assert.equal(gated.status, 401);
const withCookie = await worker.fetch(new Request("http://x/api/search?location=E14", { headers: { cookie: "jit_auth=t" } }), { ...env, ACCESS_TOKEN: "t" } as any);
assert.equal(withCookie.status, 400, "cookie authorises (400 = got past auth, failed validation)");
const link = await worker.fetch(new Request("http://x/?token=t"), { ...env, ACCESS_TOKEN: "t" } as any);
assert.equal(link.status, 200); // share link: page signs in (cookie + saved code) and cleans the URL
assert.ok(link.headers.get("set-cookie")?.includes("jit_auth=t"));
const page = await link.text();
assert.ok(page.includes('localStorage.setItem("jit_token","t")') && page.includes("history.replaceState") && !page.includes('name="token"'));
const badLink = await worker.fetch(new Request("http://x/?token=wrong"), { ...env, ACCESS_TOKEN: "t" } as any);
assert.ok((await badLink.text()).includes('name="token"') && !badLink.headers.get("set-cookie"));
const share = await worker.fetch(new Request("http://x/api/share-link", { headers: { "x-access-token": "t" } }), { ...env, ACCESS_TOKEN: "t", PUBLIC_URL: "https://jit.run.app/" } as any);
assert.equal((await share.json() as any).url, "https://jit.run.app/?token=t");
assert.equal((await worker.fetch(new Request("http://x/api/share-link"), { ...env, ACCESS_TOKEN: "t" } as any)).status, 401);
assert.equal((await worker.fetch(new Request("http://x/api/cron/tick", { method: "POST" }), { ...env, ACCESS_TOKEN: "t" } as any)).status, 401);
console.log("SMOKE OK");

// --- Apify (Rightmove + Zoopla) adapter with mocked actor output
const prevFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input.url ?? input);
  if (url.includes("api.apify.com")) {
    const j = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (url.includes("rightmove")) return j([
      { type: "property", url: "https://www.rightmove.co.uk/properties/111", displayPrice: "£2,950 pcm", bedrooms: 2, bathrooms: 2, address: "Westferry Circus, E14", outcode: "E14", latitude: 51.505, longitude: -0.026, agentName: "Dockside Lettings", agentBranch: "Canary Wharf", agentPhone: "020 7123 4567", letAvailableDate: "01/10/2026", furnishType: "Furnished" },
      { type: "property", url: "https://www.rightmove.co.uk/properties/999", displayPrice: "£650,000", bedrooms: 2, latitude: 51.505, longitude: -0.02 },
      { type: "property", url: "https://www.rightmove.co.uk/properties/444", displayPrice: "£2,000 pcm", bedrooms: 2, displayAddress: "Bath House, Barking IG11", latitude: 51.536, longitude: 0.08 },
    ]);
    if (url.includes("onthemarket")) return j([
      { id: "20014416", url: "https://www.onthemarket.com/details/20014416/", title: "2 bedroom flat to rent", address: "White Horse Lane, Stepney, London, E1", price: "£3,400 pcm (£785 pw)", bedrooms: 2, agent_name: "Stepney Lets", agent_phone: "020 7111 2222", location_lat: 51.505, location_lon: -0.03 },
      { id: "1", url: "https://www.onthemarket.com/details/1/", title: "2 bedroom flat for sale", address: "E14", price: "£450,000", bedrooms: 2, location_lat: 51.505, location_lon: -0.03 },
    ]);
    if (url.includes("openrent")) return j([
      { listing_id: "3041118", link: "https://www.openrent.co.uk/3041118", price_pcm: 2400, rent: "£2400.00", bedrooms: "2", bathrooms: "2", furnishing: "Furnished", minimum_tenancy_months: 3, available_from: "06 November, 2026", latitude: "51.50744", longitude: "-0.02985", title: "2 Bed Flat, Lime Kiln Wharf, E14", address: "Lime Kiln Wharf", location: "London", postcode: "E14", landlord_name: "Sam", is_room_in_shared_house: false },
      { listing_id: "9", link: "https://www.openrent.co.uk/9", price_pcm: 900, bedrooms: "2", is_room_in_shared_house: true, latitude: "51.505", longitude: "-0.02" },
    ]);
    return j([{ listingId: "74293317", url: "https://www.zoopla.co.uk/to-rent/details/74293317/", priceLabel: "£600 pw", numBedrooms: 2, numBathrooms: 1, address: "Marsh Wall, E14", latitude: 51.5, longitude: -0.018, agentName: "Zoop Lets", agentPhone: "020 7000 1111" }]);
  }
  return prevFetch(input, init);
};
const res2 = await runSearch(validate({ location: "Canary Wharf, London", checkIn: "2026-10-12", checkOut: "2027-01-10", bedrooms: 2, radiusMiles: 1 }).req!, { ...env, APIFY_TOKEN: "a", ENABLED_SOURCES: "apify,propertydata" } as any);
const rm = res2.listings.find((l) => l.url?.includes("/properties/111"))!;
assert.equal(rm.agentPhone, "020 7123 4567");
assert.equal(rm.rentPcm, 2950, "Apify record wins for the same URL");
assert.equal(rm.availableFrom, "01/10/2026");
assert.ok(!res2.listings.some((l) => l.url?.includes("/999")), "sale listing dropped");
assert.ok(!res2.listings.some((l) => l.url?.includes("/444")), "out-of-area (Barking) dropped");
assert.equal(rm.portal, "Rightmove + PropertyData (rent-to-rent)", "merged with PropertyData record for same URL");
assert.equal(res2.listings.find((l) => l.portal === "Zoopla" && l.url?.includes("74293317"))?.rentPcm, 2600, "£600 pw -> pcm");
const otm = res2.listings.find((l) => l.portal === "OnTheMarket")!;
assert.equal(otm.rentPcm, 3400); assert.equal(otm.agentPhone, "020 7111 2222");
assert.equal(res2.listings.filter((l) => l.portal === "OnTheMarket").length, 1, "OTM sale listing dropped");
const or = res2.listings.find((l) => l.portal === "OpenRent")!;
assert.equal(or.address, "Lime Kiln Wharf, London, E14");
assert.equal(or.agentName, "Landlord: Sam");
assert.ok(or.flags.includes("min tenancy 3 mo") && or.flags.includes("tenancy fits stay"), "3-month min tenancy fits a 90-night stay");
assert.equal(res2.listings.filter((l) => l.portal === "OpenRent").length, 1, "OpenRent room dropped");
console.log("APIFY OK (Rightmove, Zoopla, OnTheMarket, OpenRent)");

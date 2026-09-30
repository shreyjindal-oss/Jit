// Ambiguous place names: "Kensington, London" must not resolve to Kensington, Liverpool.
import assert from "node:assert/strict";
import { geocode } from "../src/geo";
const places: Record<string, any[]> = {
  kensington: [
    { name_1: "Kensington", county_unitary: "Liverpool", region: "North West", latitude: 53.41, longitude: -2.95 },
    { name_1: "Kensington", county_unitary: "Greater London", district_borough: "Kensington and Chelsea", region: "London", latitude: 51.5, longitude: -0.19 },
  ],
  clapham: [
    { name_1: "Clapham", county_unitary: "North Yorkshire", region: "Yorkshire and the Humber", latitude: 54.12, longitude: -2.39 },
    { name_1: "Clapham", county_unitary: "Greater London", region: "London", latitude: 51.46, longitude: -0.14 },
  ],
};
globalThis.fetch = (async (u: string) => {
  const url = new URL(u);
  if (url.pathname === "/places") { const t = (url.searchParams.get("q") || "").split(",")[0].trim().toLowerCase(); return Response.json({ result: url.searchParams.get("q")!.includes(",") ? [] : places[t] ?? [] }); }
  if (url.pathname === "/postcodes" && url.searchParams.get("lon")) return Response.json({ result: [{ postcode: "X1 1XX", outcode: "X1", admin_district: "D", region: "R", codes: { admin_district: "E0" } }] });
  return Response.json({ result: null });
}) as any;
const k = (await geocode("Kensington, London"))!; assert.ok(k.lat < 52, `got ${k.label}`);
assert.ok((await geocode("Kensington, Liverpool"))!.lat > 53);
assert.ok((await geocode("Clapham, London"))!.lat < 52);
assert.ok((await geocode("Kensington"))!.lat > 53); // no qualifier: first match (unchanged behaviour)
console.log("GEO OK");

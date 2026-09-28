// Offline test for the ONS xlsx parser + area lookup. `npm test`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePiprXlsx, onsLookup, refreshOns, getOns } from "../src/ons";

const buf = readFileSync(new URL("./fixtures/pipr-mini.xlsx", import.meta.url));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const parsed = await parsePiprXlsx(ab);
assert.equal(parsed.period, "2026-08");
assert.deepEqual(parsed.areas["E09000030"], ["Tower Hamlets", "London", 2453, 1992, 2418, 2750, 3378, 2284], "keeps the latest month per area");
assert.equal(parsed.areas["E12000007"][1], "", "[z] region -> empty");

const data = { ...parsed, release: "r", fetchedAt: "now" };
const th = onsLookup(data, { lat: 0, lng: 0, label: "", laCode: "E09000030" }, 2)!;
assert.equal(th.avgPcm, 2418); assert.equal(th.level, "local authority");
assert.equal(onsLookup(data, { lat: 0, lng: 0, label: "", district: "Manchester" }, 4)!.avgPcm, 2014, "name match, 4+ bed");
assert.equal(onsLookup(data, { lat: 0, lng: 0, label: "", district: "Nowhere", region: "London" }, 0)!.level, "region", "region fallback; studio -> 1 bed");
assert.equal(onsLookup(data, { lat: 0, lng: 0, label: "", district: "Nowhere" }, 2), null);

// refreshOns end-to-end with mocked ONS endpoints + in-memory KV
const kv = new Map<string, string>();
const env: any = { ONS_KV: { get: async (k: string, t: string) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)!) : kv.get(k)) : null), put: async (k: string, v: string) => void kv.set(k, v) } };
(globalThis as any).fetch = async (input: any) => {
  const url = String(input.url ?? input);
  const j = (o: unknown) => new Response(JSON.stringify(o));
  if (url.endsWith("priceindexofprivaterentsukmonthlypricestatistics/data")) return j({ datasets: [{ uri: "/x/16september2026" }] });
  if (url.endsWith("/x/16september2026/data")) return j({ downloads: [{ file: "pipr.xlsx" }] });
  if (url.includes("/file?uri=/x/16september2026/pipr.xlsx")) return new Response(ab);
  throw new Error("unexpected " + url);
};
const r1 = await refreshOns(env);
assert.equal(r1.updated, true); assert.equal(r1.areas, 3);
assert.equal((await getOns(env))!.period, "2026-08");
const r2 = await refreshOns(env);
assert.equal(r2.updated, false, "same release -> no re-download");
console.log("ONS OK");

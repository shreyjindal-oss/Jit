// Offline test of saveSearch/getSearch/listSearches/batchCsv against the real schema (node:sqlite as a D1 stand-in).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { saveSearch, getSearch, listSearches, searchesToday } from "../src/db";
import { batchCsv } from "../src/batch";

const db = new DatabaseSync(":memory:");
for (const m of ["0001_init.sql", "0002_alerts.sql", "0003_archive.sql"]) db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
class Stmt { constructor(public sql: string, public args: any[] = []) {}
  bind(...a: any[]) { return new Stmt(this.sql, a); }
  private conv() { return { sql: this.sql.replace(/\?(\d+)/g, (_, n) => `?${n}`), args: this.args.map((v) => (v === undefined ? null : v)) }; }
  async run() { const { sql, args } = this.conv(); db.prepare(sql).run(...args); return { success: true }; }
  async first() { const { sql, args } = this.conv(); return db.prepare(sql).get(...args) ?? null; }
  async all() { const { sql, args } = this.conv(); return { results: db.prepare(sql).all(...args) }; } }
const D1: any = { prepare: (s: string) => new Stmt(s), batch: async (ss: Stmt[]) => { for (const s of ss) await s.run(); return []; } };
const env: any = { DB: D1 };

const res: any = {
  request: { location: "E14", checkIn: "2026-11-01", checkOut: "2027-02-01", bedrooms: 2, accessibility: "ground_floor", enquiryRef: "ENQ-1" },
  geo: { lat: 51.5, lng: -0.02, label: "E14", outcode: "E14", district: "Tower Hamlets" },
  generatedAt: "now", economics: { nights: 92 }, ons: { avgPcm: 2418 }, sources: [], warnings: [],
  listings: [
    { id: "a", source: "apify", portal: "Rightmove", kind: "listing", title: "2 bed ground floor flat", address: "Westferry, E14", outcode: "E14", bedrooms: 2, rentPcm: 2600, floor: "Ground", accessFit: "fit", access: ["ground floor", "lift"], images: ["https://x/1.jpg", "https://x/2.jpg"], score: 90, flags: ["ground floor ✓"], url: "https://rightmove/1" },
    { id: "b", source: "apify", portal: "Zoopla", kind: "listing", title: "2 bed flat", address: "Marsh Wall, E14", bedrooms: 2, rentPcm: 2400, score: 70, flags: [], url: "https://zoopla/2" },
  ],
};
const id = (await saveSearch(env, res, { source: "ui", durationMs: 1234 }))!;
const back = (await getSearch(env, id))!;
assert.equal(back.listings.length, 2);
assert.deepEqual(back.listings[0].images, ["https://x/1.jpg", "https://x/2.jpg"]);
assert.equal(back.listings[0].floor, "Ground"); assert.equal(back.listings[0].accessFit, "fit");
assert.equal((back as any).ons.avgPcm, 2418);
const list = await listSearches(env, 10, "E14");
assert.equal(list.length, 1); assert.equal((list[0] as any).median_rent_pcm, 2500); assert.equal((list[0] as any).la_name, "Tower Hamlets");
assert.equal(await searchesToday(env), 1);
// batch CSV join
db.prepare(`INSERT INTO batches (id, created_at, filename, total) VALUES ('b1','now','t.csv',1)`).run();
db.prepare(`INSERT INTO batch_rows (batch_id,row_no,status,request_json,search_id,listing_count) VALUES ('b1',2,'done','{}',?,2)`).run(id);
const csv = await batchCsv(env, "b1");
assert.equal(csv.trim().split("\n").length, 3); assert.ok(csv.includes("https://x/1.jpg") && csv.includes("Westferry"));
console.log("DB OK");

// Housekeeping: filtered copy (4 & 5 bed only) + archive everything except it + restore
{
  const { deriveSearch, setArchived, activeIds, listSearches: ls } = await import("../src/db");
  const big: any = { ...res, request: { ...res.request, bedrooms: 0, bedroomOptions: [0, 1, 2, 3, 4, 5, 6], enquiryRef: "JIT-CSV-02 E11" },
    listings: [2, 4, 5, 5, 1, 6].map((b, i) => ({ id: "x" + i, source: "apify", portal: "Zoopla", kind: "listing", title: `${b} bed`, address: `A${i}`, bedrooms: b, rentPcm: 1000 * b || 900, score: 50 + i, flags: [], images: [`https://i/${i}.jpg`], url: `https://z/${i}` })) };
  const srcId = (await saveSearch(env, big, { source: "batch" }))!;
  const d = (await deriveSearch(env, srcId, { bedrooms: [5, 4], enquiryRef: "JIT2-02 E11 4 & 5 bed" }))!;
  assert.equal(d.kept, 3);
  const copy = (await getSearch(env, d.id!))!;
  assert.deepEqual(copy.listings.map((l) => l.bedrooms), [4, 5, 5]); assert.deepEqual(copy.listings[0].images, ["https://i/1.jpg"]);
  assert.deepEqual([copy.request.bedrooms, copy.request.bedroomOptions, copy.request.enquiryRef], [4, [4, 5], "JIT2-02 E11 4 & 5 bed"]);
  assert.ok(copy.warnings.some((w: string) => /4 & 5 bed listings only/.test(w)));
  // archive all except the copy
  const toArchive = (await activeIds(env, "searches")).filter((id) => id !== d.id);
  assert.equal(await setArchived(env, "searches", toArchive, true), toArchive.length);
  const visible = await ls(env, 100);
  assert.deepEqual(visible.map((s: any) => s.id), [d.id]);
  assert.equal((await ls(env, 100, undefined, true)).length, toArchive.length);
  assert.ok(await getSearch(env, srcId)); // archived ≠ deleted
  await setArchived(env, "searches", [srcId], false);
  assert.equal((await ls(env, 100)).length, 2);
  // archiving a batch cancels its pending rows and hides it
  const { listBatches } = await import("../src/batch");
  db.prepare(`INSERT INTO batches (id, created_at, filename, total) VALUES ('b9','now','old.csv',1)`).run();
  db.prepare(`INSERT INTO batch_rows (batch_id,row_no,status,request_json) VALUES ('b9',2,'pending','{}')`).run();
  await setArchived(env, "batches", ["b9"], true);
  assert.ok(!(await listBatches(env)).some((b: any) => b.id === "b9"));
  assert.equal((db.prepare(`SELECT status FROM batch_rows WHERE batch_id='b9'`).get() as any).status, "cancelled");
  console.log("ARCHIVE + DERIVE OK");
}

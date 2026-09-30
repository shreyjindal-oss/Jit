// Postgres path (Cloud Run): the same app code against real Postgres (PGlite, in-process) through server/pg-adapter.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { makeD1, makeKv, toPg, type Exec, type Tx } from "../server/pg-adapter";
import { migrate } from "../server/main";
import { saveSearch, getSearch, listSearches, searchesToday } from "../src/db";
import { createAlert, processAlertsTick, stopAlert, listAlerts } from "../src/alerts";
import { processBatchTick, getBatch } from "../src/batch";

// SQL translation
assert.equal(toPg("SELECT * FROM a WHERE x = ?1 AND y LIKE ?2 LIMIT ?1"), "SELECT * FROM a WHERE x = $1 AND y ILIKE $2 LIMIT $1");
assert.equal(toPg("INSERT OR IGNORE INTO t (a) VALUES (?1)"), "INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING");

const db = new PGlite();
const num = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
const exec: Exec = async (sql, params) => {
  if (!params.length) { const rs = await db.exec(sql); const last: any = rs[rs.length - 1] ?? { rows: [] }; return { rows: num(last.rows ?? []), rowCount: last.affectedRows ?? 0 }; }
  const r: any = await db.query(sql, params as any[]); return { rows: num(r.rows), rowCount: r.affectedRows ?? 0 };
};
const tx: Tx = (fn) => db.transaction(async (t) => fn(async (sql, params) => { const r: any = await t.query(sql, params as any[]); return { rows: r.rows, rowCount: r.affectedRows ?? 0 }; })) as any;
await migrate(exec);
await migrate(exec); // idempotent
const env: any = { DB: makeD1(exec, tx), ONS_KV: makeKv(exec), SENDGRID_API_KEY: "SG.x", PUBLIC_URL: "https://jit.run.app", ACCESS_TOKEN: "code123", MAX_SEARCHES_PER_DAY: "100" };

// saved searches
const res: any = {
  request: { location: "E14", checkIn: "2026-11-01", checkOut: "2027-02-01", bedrooms: 2, bedroomOptions: [2, 3], accessibility: "ground_floor", accessNeeds: ["ground_floor", "step_free"], enquiryRef: "ENQ-9" },
  geo: { outcode: "E14", district: "Tower Hamlets" }, generatedAt: "now", economics: {}, ons: { avgPcm: 2418 }, sources: [], warnings: [],
  listings: [
    { portal: "Rightmove", kind: "listing", title: "2 bed", address: "Westferry", bedrooms: 2, bathrooms: 1.5, rentPcm: 2600, score: 90, flags: ["x"], images: ["https://i/1.jpg"], url: "https://r/1", lat: 51.5, lng: -0.02, distanceMiles: 0.4 },
    { portal: "Zoopla", kind: "listing", title: "3 bed", address: "Marsh Wall", bedrooms: 3, rentPcm: 3000, score: 70, flags: [], url: "https://z/2" },
  ],
};
const id = (await saveSearch(env, res, { source: "ui", durationMs: 10 }))!;
const back = (await getSearch(env, id))!;
assert.equal(back.listings.length, 2); assert.equal(back.listings[0].bathrooms, 1.5); assert.deepEqual(back.listings[0].images, ["https://i/1.jpg"]);
const list = await listSearches(env, 10, "enq-9"); // ILIKE: case-insensitive like D1
assert.equal(list.length, 1); assert.equal((list[0] as any).accessibility, "ground_floor,step_free"); assert.equal((list[0] as any).median_rent_pcm, 2800);
assert.equal(typeof (await searchesToday(env)), "number"); assert.equal(await searchesToday(env), 1);

// alerts: create, guard, due run, diff, SendGrid payload with share link, stop
const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const search = { location: "E14", checkIn: d(10), checkOut: d(100), bedrooms: [2, 3], mustHave: ["parking"] };
const a = await createAlert(env, { email: "sid@thesqua.re", frequencyDays: 1, startDate: d(0), endDate: d(10), search }); assert.ok(a.id, JSON.stringify(a));
assert.match((await createAlert(env, { email: "x@gmail.com", frequencyDays: 1, startDate: d(0), endDate: d(10), search })).error!, /company/);
const sent: any[] = [];
globalThis.fetch = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response("", { status: 202 }); }) as any;
let listings = res.listings;
const fake: any = async (req: any) => ({ ...res, request: req, listings });
let r = await processAlertsTick(env, fake);
assert.equal(r.ran, a.id); assert.equal(r.newCount, 2); assert.equal(sent.length, 1);
assert.ok(sent[0].content[0].value.includes("https://jit.run.app/?token=code123"));
r = await processAlertsTick(env, fake); assert.equal(r.ran, undefined); // not due
await exec(`UPDATE alerts SET next_run_at = $1`, [new Date(Date.now() - 1000).toISOString()]);
listings = [...res.listings, { ...res.listings[1], url: "https://z/3", address: "New" }];
r = await processAlertsTick(env, fake); assert.equal(r.newCount, 1); assert.equal(sent.length, 2);
const al = (await listAlerts(env))[0]; assert.equal(al.runs, 2); assert.equal(al.emails_sent, 2);
assert.equal(await stopAlert(env, a.id!), true); assert.equal(await stopAlert(env, a.id!), false);

// bulk rows: atomic claim — two overlapping ticks never take the same row
await exec(`INSERT INTO batches (id, created_at, filename, total) VALUES ('b1', $1, 't.csv', 1)`, [new Date().toISOString()]);
await exec(`INSERT INTO batch_rows (batch_id, row_no, request_json) VALUES ('b1', 2, $1)`, [JSON.stringify({ location: "Nowhere", checkIn: d(10), checkOut: d(40), bedrooms: 2 })]);
globalThis.fetch = (async () => new Response("[]", { status: 200 })) as any; // geocode finds nothing → row still completes
const [t1, t2] = await Promise.all([processBatchTick(env), processBatchTick(env)]);
assert.equal(t1.processed + t2.processed, 1);
const b: any = await getBatch(env, "b1"); assert.equal(b.status, "done"); assert.ok(["done", "error"].includes(b.rows[0].status));

// KV replacement
await env.ONS_KV.put("ons:pipr", JSON.stringify({ period: "Aug 2026", areas: { E09000030: [1, 2] } }));
assert.equal((await env.ONS_KV.get("ons:pipr", "json")).period, "Aug 2026");
await env.ONS_KV.put("ons:pipr", JSON.stringify({ period: "Sep 2026" }));
assert.equal((await env.ONS_KV.get("ons:pipr", "json")).period, "Sep 2026");
assert.equal(await env.ONS_KV.get("missing"), null);
console.log("POSTGRES OK");

// D1 export → Postgres import
{
  const { convertDump } = await import("../scripts/import-d1");
  const dump = [
    "PRAGMA defer_foreign_keys=TRUE;",
    `INSERT INTO "d1_migrations" VALUES(1,'0001_init.sql','2026-09-01');`,
    `INSERT INTO "listings" VALUES(7,'s-old',1,'Rightmove','https://r/9','2 bed','1 Road',NULL,2,1,2500,NULL,'Furnished',NULL,NULL,'[]',NULL,NULL,51.5,-0.1,0.5,80,'[]','[]',replace('line1\\nline2','\\n',char(10)));`,
    `INSERT INTO "searches" VALUES('s-old','2026-09-20T10:00:00Z','ui',NULL,'O''Brien Street',NULL,NULL,2,NULL,'2026-10-01','2026-12-01','any',NULL,NULL,1,2500,NULL,1000,'{}','{}');`,
  ].join("\n");
  const stmts = convertDump(dump);
  assert.equal(stmts.length, 2); assert.ok(stmts[0].startsWith("INSERT INTO searches")); // parent first
  for (const s of stmts) assert.equal((await exec(s, [])).rowCount, 1); // listing id 7 already exists in Postgres — must still import
  await exec(`SELECT setval(pg_get_serial_sequence('listings','id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM listings), 1))`, []);
  const old = (await getSearch(env, "s-old"))!;
  assert.equal(old.listings[0].snippet, "line1\nline2");
  assert.equal(((await listSearches(env, 10, "o'brien"))[0] as any).location, "O'Brien Street");
  assert.equal(convertDump(dump, new Set(["s-old"])).length, 1); // re-run: listings of already-imported searches skipped
  await saveSearch(env, res, { source: "ui" }); // new listing ids continue after the imported max(id)
  const ids = (await exec(`SELECT id FROM listings ORDER BY id`, [])).rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  console.log("D1 IMPORT OK");
}

// Bulk rows when Apify is out of credit: row fails (no misleading "0 listings" saved search); cancel + retry
{
  const { cancelBatch, retryBatch, listBatches } = await import("../src/batch");
  const d2 = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await exec(`INSERT INTO batches (id, created_at, filename, total) VALUES ('b2', $1, 'jit2.csv', 3)`, [new Date().toISOString()]);
  for (const n of [2, 3, 4]) await exec(`INSERT INTO batch_rows (batch_id, row_no, request_json) VALUES ('b2', $1, $2)`, [n, JSON.stringify({ location: "E15", checkIn: d2(10), checkOut: d2(60), bedrooms: [4, 5] })]);
  const before = (await exec(`SELECT COUNT(*) n FROM searches`, [])).rows[0].n;
  globalThis.fetch = (async (u: string) => {
    if (String(u).includes("apify.com")) return new Response('{"error":{"type":"platform-feature-disabled","message":"Monthly usage hard limit exceeded"}}', { status: 403 });
    if (String(u).includes("/outcodes/")) return Response.json({ result: { outcode: "E15", latitude: 51.54, longitude: 0, admin_district: ["Newham"] } });
    return Response.json({ result: [{ postcode: "E15 1AA", outcode: "E15", admin_district: "Newham", region: "London", codes: { admin_district: "E09000025" } }] });
  }) as any;
  const env2 = { ...env, APIFY_TOKEN: "t", ENABLED_SOURCES: "apify", BATCH_CONCURRENCY: "1" };
  await processBatchTick(env2);
  let b2: any = await getBatch(env2, "b2");
  assert.equal(b2.rows[0].status, "error"); assert.match(b2.rows[0].error, /Apify credit\/limit reached/);
  assert.equal((await exec(`SELECT COUNT(*) n FROM searches`, [])).rows[0].n, before); // nothing saved
  assert.equal((await cancelBatch(env2, "b2")).cancelled, 2);
  assert.equal((await processBatchTick(env2)).processed, 0); // cancelled rows never run
  const lb: any = (await listBatches(env2)).find((x: any) => x.id === "b2");
  assert.deepEqual([lb.errors, lb.cancelled, lb.pending, lb.status], [1, 2, 0, "cancelled"]);
  assert.equal((await retryBatch(env2, "b2")).requeued, 3);
  b2 = await getBatch(env2, "b2"); assert.ok(b2.rows.every((r: any) => r.status === "pending" && r.attempts === 0)); assert.equal(b2.status, "queued");
  // "Retry empty" also re-queues rows that finished with 0 listings
  await exec(`UPDATE batch_rows SET status='done', listing_count=0 WHERE batch_id='b2' AND row_no=2`, []);
  await cancelBatch(env2, "b2");
  assert.equal((await retryBatch(env2, "b2")).requeued, 2);
  assert.equal((await retryBatch(env2, "b2", true)).requeued, 1);
  console.log("BATCH CANCEL/RETRY OK");
}

// Housekeeping on Postgres
{
  const { deriveSearch, setArchived, activeIds } = await import("../src/db");
  const id2 = (await saveSearch(env, res, { source: "batch" }))!;
  const d = (await deriveSearch(env, id2, { bedrooms: [3] }))!; assert.equal(d.kept, 1);
  const n = (await activeIds(env, "searches")).filter((x) => x !== d.id);
  await setArchived(env, "searches", n, true);
  assert.deepEqual((await listSearches(env, 500)).map((s: any) => s.id), [d.id]);
  const al = (await activeIds(env, "alerts")); await setArchived(env, "alerts", al, true);
  assert.equal((await listAlerts(env)).length, 0);
  console.log("PG ARCHIVE OK");
}

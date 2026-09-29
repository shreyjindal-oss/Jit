// Offline test of alerts: validation/misuse limits, due-run processing, new-listing diff, SendGrid payload.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createAlert, processAlertsTick, stopAlert, listAlerts } from "../src/alerts";

const db = new DatabaseSync(":memory:");
for (const m of ["0001_init.sql", "0002_alerts.sql"]) db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
class Stmt { constructor(public sql: string, public args: any[] = []) {}
  bind(...a: any[]) { return new Stmt(this.sql, a); }
  private a() { return this.args.map((v) => (v === undefined ? null : v)); }
  async run() { const r = db.prepare(this.sql).run(...this.a()); return { success: true, meta: { changes: Number(r.changes) } }; }
  async first() { return db.prepare(this.sql).get(...this.a()) ?? null; }
  async all() { return { results: db.prepare(this.sql).all(...this.a()) }; } }
const D1: any = { prepare: (s: string) => new Stmt(s), batch: async (ss: Stmt[]) => { for (const s of ss) await s.run(); return []; } };
const env: any = { DB: D1, SENDGRID_API_KEY: "SG.test", PUBLIC_URL: "https://jit.example", MAX_ALERTS_PER_EMAIL: "2", MAX_ACTIVE_ALERTS: "3", MAX_SEARCHES_PER_DAY: "100" };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const day = (n: number) => ymd(new Date(Date.now() + n * 864e5));
const search = { location: "E14", checkIn: day(10), checkOut: day(100), bedrooms: 2, accessibility: "ground_floor" };
const ok = { email: "sid@thesqua.re", frequencyDays: 1, startDate: day(0), endDate: day(14), search };

// validation + misuse guards
assert.match((await createAlert(env, { ...ok, email: "x@gmail.com" })).error!, /company addresses/);
assert.match((await createAlert(env, { ...ok, frequencyDays: 15 })).error!, /fortnightly/);
assert.match((await createAlert(env, { ...ok, frequencyDays: 0 })).error!, /fortnightly/);
assert.match((await createAlert(env, { ...ok, endDate: day(31) })).error!, /30 days/);
assert.match((await createAlert(env, { ...ok, startDate: day(-1) })).error!, /past/);
assert.match((await createAlert(env, { ...ok, search: { location: "" } })).error!, /Search/);
const a1 = await createAlert(env, ok); assert.ok(a1.id, JSON.stringify(a1));
assert.ok((await createAlert(env, { ...ok, endDate: day(30), frequencyDays: 14 })).id); // exactly 30 days + fortnightly OK
assert.match((await createAlert(env, ok)).error!, /already has 2/); // per-email cap
assert.ok((await createAlert(env, { ...ok, email: "ops@thesqua.re" })).id);
assert.match((await createAlert(env, { ...ok, email: "pm@thesqua.re" })).error!, /3 active alerts/); // global cap

// fake search + SendGrid
let listings: any[] = [
  { portal: "Rightmove", kind: "listing", title: "2 bed", address: "Westferry, E14", bedrooms: 2, rentPcm: 2600, floor: "Ground", url: "https://www.rightmove.co.uk/properties/1/", images: ["https://x/1.jpg"], score: 90, flags: [] },
  { portal: "Zoopla", kind: "listing", title: "2 bed", address: "Marsh Wall", bedrooms: 2, rentPcm: 2400, url: "https://zoopla.co.uk/to-rent/2", score: 70, flags: [] },
];
const fakeSearch: any = async (req: any) => ({ request: req, geo: { outcode: "E14" }, generatedAt: "now", economics: {}, ons: { avgPcm: 2418 }, sources: [], warnings: [], listings });
const sent: any[] = [];
globalThis.fetch = (async (url: string, init: any) => { assert.equal(url, "https://api.sendgrid.com/v3/mail/send"); sent.push(JSON.parse(init.body)); return new Response("", { status: 202 }); }) as any;

// Make only a1 due.
db.prepare(`UPDATE alerts SET next_run_at = ? WHERE id != ?`).run(new Date(Date.now() + 864e5).toISOString(), a1.id!);
let r = await processAlertsTick(env, fakeSearch);
assert.equal(r.ran, a1.id); assert.equal(r.newCount, 2); assert.equal(sent.length, 1);
const m = sent[0];
assert.equal(m.from.email, "noreply@thesqua.re"); assert.equal(m.personalizations[0].to[0].email, "sid@thesqua.re");
assert.ok(m.content[0].value.includes("Westferry") && m.content[0].value.includes("/alerts/stop?id=" + a1.id));
// not due again today
r = await processAlertsTick(env, fakeSearch); assert.equal(r.ran, undefined);
// next day: one new listing (same Rightmove URL with different form must not count as new)
db.prepare(`UPDATE alerts SET next_run_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), a1.id!);
listings = [{ ...listings[0], url: "https://rightmove.co.uk/properties/1" }, listings[1], { ...listings[1], url: "https://zoopla.co.uk/to-rent/3", address: "New one" }];
r = await processAlertsTick(env, fakeSearch);
assert.equal(r.newCount, 1); assert.equal(sent.length, 2); assert.match(sent[1].subject, /^1 new/);
// nothing new → no email
db.prepare(`UPDATE alerts SET next_run_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), a1.id!);
r = await processAlertsTick(env, fakeSearch); assert.equal(r.newCount, 0); assert.equal(sent.length, 2);
const row: any = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(a1.id!);
assert.equal(row.runs, 3); assert.equal(row.emails_sent, 2); assert.equal(row.status, "active");
assert.ok(row.next_run_at > new Date().toISOString());
// searches saved with source "alert"
assert.equal((db.prepare(`SELECT COUNT(*) n FROM searches WHERE source='alert'`).get() as any).n, 3);

// stop via token (wrong token fails), expiry ends alerts
assert.equal(await stopAlert(env, a1.id!, "wrong"), false);
assert.equal(await stopAlert(env, a1.id!, row.stop_token), true);
db.prepare(`UPDATE alerts SET end_date = ? WHERE status='active'`).run(day(-1));
await processAlertsTick(env, fakeSearch);
const all = await listAlerts(env);
assert.ok(all.every((a) => a.status !== "active")); assert.equal(all.find((a) => a.id === a1.id).status, "stopped");
console.log("ALERTS OK");

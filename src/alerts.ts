import type { Env, Listing, SearchRequest } from "./types";
import { runSearch, validate } from "./pipeline";
import { newId, saveSearch, searchesToday } from "./db";
import { bedsLabel, filtersSummary } from "./filters";

/**
 * Listing alerts. A user saves search parameters + an email; the every-minute cron picks up due alerts
 * (one per tick), re-runs the search, and emails only listings not seen before (via SendGrid).
 *
 * Guard rails against misuse:
 *  - frequency 1–14 days (daily … fortnightly); window start→end at most 30 days, starting within 30 days
 *  - recipients limited to company domains (ALERT_EMAIL_DOMAINS)
 *  - MAX_ACTIVE_ALERTS overall, MAX_ALERTS_PER_EMAIL per recipient
 *  - every alert run counts toward MAX_SEARCHES_PER_DAY
 *  - one-click stop link in every email; no email is sent when there's nothing new
 */

const DAY = 86400000;
const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const RUN_HOUR_UTC = 7; // scheduled runs go out ~07:00 UTC (08:00 UK summer time)

function normUrl(u?: string): string | undefined {
  if (!u) return undefined;
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "")).toLowerCase(); } catch { return u; }
}
const keyOf = (l: Listing) => normUrl(l.url) ?? `${l.portal}|${l.address}|${l.rentPcm}`;

export interface AlertInput {
  name?: string; email?: string; frequencyDays?: number | string; startDate?: string; endDate?: string; search?: any;
}

export async function createAlert(env: Env, body: AlertInput): Promise<{ id?: string; error?: string; warning?: string }> {
  if (!env.DB) return { error: "DB binding missing" };
  const { req, error } = validate(body.search ?? {});
  if (!req) return { error: `Search: ${error}` };

  const email = String(body.email ?? "").trim().toLowerCase();
  const domains = (env.ALERT_EMAIL_DOMAINS || "thesqua.re").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email" };
  if (!domains.includes(email.split("@")[1])) return { error: `Alerts can only be sent to company addresses (${domains.map((d) => "@" + d).join(", ")})` };

  const freq = Number(body.frequencyDays ?? 1);
  if (!Number.isInteger(freq) || freq < 1 || freq > 14) return { error: "Frequency must be between 1 day (daily) and 14 days (fortnightly)" };

  const today = new Date(ymd(new Date()));
  const start = new Date(String(body.startDate || ymd(today)));
  const end = new Date(String(body.endDate || ""));
  if (isNaN(+start) || isNaN(+end)) return { error: "Start and end dates are required (YYYY-MM-DD)" };
  if (+start < +today) return { error: "Start date can't be in the past" };
  if (+start > +today + 30 * DAY) return { error: "Start date must be within the next 30 days" };
  if (+end < +start) return { error: "End date must be on or after the start date" };
  if ((+end - +start) / DAY > 30) return { error: "An alert can run for at most 30 days (start → end)" };

  const maxActive = Number(env.MAX_ACTIVE_ALERTS || 20), maxPerEmail = Number(env.MAX_ALERTS_PER_EMAIL || 3);
  const counts: any = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN email = ?1 THEN 1 ELSE 0 END) AS mine FROM alerts WHERE status = 'active'`,
  ).bind(email).first();
  if ((counts?.total ?? 0) >= maxActive) return { error: `There are already ${maxActive} active alerts (the limit). Stop one first.` };
  if ((counts?.mine ?? 0) >= maxPerEmail) return { error: `${email} already has ${maxPerEmail} active alerts (the limit). Stop one first.` };

  // First run: straight away if it starts today, otherwise the start morning.
  const firstRun = +start === +today ? new Date() : new Date(+start + RUN_HOUR_UTC * 3600000);
  const id = newId();
  const name = String(body.name || `${bedsLabel(req)} · ${req.location}`).slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO alerts (id, created_at, name, email, request_json, frequency_days, start_date, end_date, next_run_at, status, stop_token)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'active',?10)`,
  ).bind(id, iso(new Date()), name, email, JSON.stringify(req), freq, ymd(start), ymd(end), iso(firstRun), crypto.randomUUID()).run();
  return { id, warning: env.SENDGRID_API_KEY ? undefined : "SENDGRID_API_KEY is not set — the alert will run but can't email yet." };
}

export async function listAlerts(env: Env): Promise<any[]> {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, name, email, request_json, frequency_days, start_date, end_date, next_run_at, last_run_at, runs, emails_sent,
            last_new_count, last_error, status FROM alerts ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 100`,
  ).all<any>();
  return results.map((a) => ({ ...a, request: JSON.parse(a.request_json), request_json: undefined }));
}

export async function stopAlert(env: Env, id: string, token?: string): Promise<boolean> {
  if (!env.DB) return false;
  const q = token
    ? env.DB.prepare(`UPDATE alerts SET status='stopped' WHERE id=?1 AND stop_token=?2 AND status='active'`).bind(id, token)
    : env.DB.prepare(`UPDATE alerts SET status='stopped' WHERE id=?1 AND status='active'`).bind(id);
  const r: any = await q.run();
  return (r?.meta?.changes ?? 1) > 0;
}

/** Run one alert now: search, diff against listings already sent, email the new ones. */
type SearchFn = typeof runSearch;
export async function runAlert(env: Env, a: any, search: SearchFn = runSearch): Promise<{ newCount: number; emailed: boolean }> {
  const req: SearchRequest = JSON.parse(a.request_json);
  const t0 = Date.now();
  const res = await search(req, env);
  await saveSearch(env, res, { source: "alert", durationMs: Date.now() - t0 }).catch(() => null);

  const { results } = await env.DB!.prepare(`SELECT url_key FROM alert_seen WHERE alert_id = ?1`).bind(a.id).all<any>();
  const seen = new Set(results.map((r) => r.url_key));
  const fresh = res.listings.filter((l) => !seen.has(keyOf(l)));
  let emailed = false;
  if (fresh.length) {
    const first = (a.emails_sent ?? 0) === 0; // first successful email = "what's available now"
    await sendAlertEmail(env, a, req, fresh.slice(0, 15), fresh.length, first, res.ons?.avgPcm);
    emailed = true;
  }
  // Mark as sent only after the email went out, so a failed send (bad key, SendGrid down) is retried next run.
  const now = iso(new Date());
  const stmts = fresh.map((l) => env.DB!.prepare(`INSERT OR IGNORE INTO alert_seen (alert_id, url_key, first_seen) VALUES (?1,?2,?3)`).bind(a.id, keyOf(l), now));
  for (let i = 0; i < stmts.length; i += 90) await env.DB!.batch(stmts.slice(i, i + 90));
  return { newCount: fresh.length, emailed };
}

/** Called by the every-minute cron: end expired alerts, then run at most one due alert. */
export async function processAlertsTick(env: Env, search: SearchFn = runSearch): Promise<{ ran?: string; newCount?: number }> {
  if (!env.DB) return {};
  const nowD = new Date(), now = iso(nowD);
  await env.DB.prepare(`UPDATE alerts SET status='ended' WHERE status='active' AND end_date < ?1`).bind(ymd(nowD)).run();
  const a: any = await env.DB.prepare(`SELECT * FROM alerts WHERE status='active' AND next_run_at <= ?1 ORDER BY next_run_at LIMIT 1`).bind(now).first();
  if (!a) return {};
  if ((await searchesToday(env)) >= Number(env.MAX_SEARCHES_PER_DAY || 100)) return {}; // try again tomorrow

  // Claim it first (so an overlapping tick can't double-run): schedule the next run.
  const next = new Date(Date.parse(ymd(nowD)) + a.frequency_days * DAY + RUN_HOUR_UTC * 3600000);
  const ended = ymd(next) > a.end_date;
  const claim: any = await env.DB.prepare(`UPDATE alerts SET next_run_at=?2, last_run_at=?3, status=?4 WHERE id=?1 AND next_run_at=?5`)
    .bind(a.id, iso(next), now, ended ? "ended" : "active", a.next_run_at).run();
  if ((claim?.meta?.changes ?? 1) === 0) return {};

  try {
    const r = await runAlert(env, a, search);
    await env.DB.prepare(`UPDATE alerts SET runs=runs+1, emails_sent=emails_sent+?2, last_new_count=?3, last_error=NULL WHERE id=?1`)
      .bind(a.id, r.emailed ? 1 : 0, r.newCount).run();
    return { ran: a.id, newCount: r.newCount };
  } catch (e: any) {
    await env.DB.prepare(`UPDATE alerts SET runs=runs+1, last_error=?2 WHERE id=?1`).bind(a.id, String(e?.message ?? e).slice(0, 500)).run();
    return { ran: a.id };
  }
}

// ---------------------------------------------------------------- email

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const gbp = (n?: number) => (n == null ? "—" : "£" + Math.round(n).toLocaleString("en-GB"));

export function alertEmailHtml(env: Env, a: any, req: SearchRequest, ls: Listing[], total: number, first: boolean, onsPcm?: number): string {
  const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
  const stop = base ? `${base}/alerts/stop?id=${a.id}&t=${a.stop_token}` : "";
  const beds = bedsLabel(req);
  const access = filtersSummary(req) ? ` · ${filtersSummary(req)}` : "";
  const rows = ls.map((l) => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:top;width:132px">
      ${l.images?.[0] ? `<a href="${esc(l.url)}"><img src="${esc(l.images[0])}" width="120" height="80" style="object-fit:cover;border-radius:6px;display:block" alt=""></a>` : ""}
    </td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #eee;vertical-align:top;font:14px/1.4 Arial,sans-serif;color:#16181d">
      <b>${esc(l.address || l.title)}</b><br>
      <span style="color:#1f5eff;font-weight:bold">${gbp(l.rentPcm)} pcm</span> · ${l.bedrooms ?? "?"} bed${l.bathrooms ? ` · ${l.bathrooms} bath` : ""} · ${esc(l.portal)}${l.distanceMiles != null ? ` · ${l.distanceMiles} mi` : ""}<br>
      ${[l.propertyType ? l.propertyType[0].toUpperCase() + l.propertyType.slice(1) : "", l.floor ? `Floor: ${l.floor}` : "", (l.access || []).join(", "), (l.amenities || []).join(", "), l.availableFrom ? `Available ${l.availableFrom}` : "", l.furnished || ""].filter(Boolean).map(esc).join(" · ")}<br>
      ${l.agentName ? esc(l.agentName) : ""}${l.agentPhone ? ` · <a href="tel:${esc(l.agentPhone.replace(/\s/g, ""))}">${esc(l.agentPhone)}</a>` : ""}
      ${l.url ? ` · <a href="${esc(l.url)}">View listing</a>` : ""}
    </td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:20px 0"><tr><td align="center">
  <table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;padding:20px 24px;font:14px/1.45 Arial,sans-serif;color:#16181d">
    <tr><td><div style="font-size:12px;color:#626a78">thesqua.re · JIT inventory alert</div>
      <h2 style="margin:6px 0 4px;font-size:18px">${first ? "Current" : "New"} listings: ${esc(beds)} in ${esc(req.location)}${esc(access)}</h2>
      <div style="color:#626a78">${total} ${first ? "listing(s) match right now" : "new since the last check"}${total > ls.length ? ` — showing the top ${ls.length}` : ""} · stay ${esc(req.checkIn)} → ${esc(req.checkOut)}${onsPcm ? ` · ONS area average ${gbp(onsPcm)} pcm` : ""}</div>
    </td></tr>
    <tr><td><table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
    <tr><td style="padding-top:14px;font-size:12px;color:#626a78">Alert "${esc(a.name)}" · every ${a.frequency_days === 1 ? "day" : a.frequency_days + " days"} until ${esc(a.end_date)}.
      ${base ? `<a href="${base}/${env.ACCESS_TOKEN ? `?token=${encodeURIComponent(env.ACCESS_TOKEN)}` : ""}">Open the sourcer</a> · ` : ""}${stop ? `<a href="${stop}">Stop this alert</a>` : ""}<br>
      Accessibility and availability are read from listing text — always confirm with the agent or landlord.</td></tr>
  </table></td></tr></table></body></html>`;
}

async function sendAlertEmail(env: Env, a: any, req: SearchRequest, ls: Listing[], total: number, first: boolean, onsPcm?: number) {
  if (!env.SENDGRID_API_KEY) throw new Error("SENDGRID_API_KEY not set — can't email");
  const extra = [...(req.accessNeeds ?? []).map((a) => a.replace("_", " ")), ...(req.mustHave ?? []).map((f) => f.replace("_", " "))].join(", ");
  const subject = `${first ? "" : `${total} new · `}${bedsLabel(req)} in ${req.location}${extra ? ` (${extra})` : ""} — JIT alert`;
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { authorization: `Bearer ${env.SENDGRID_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: a.email }] }],
      from: { email: env.ALERT_FROM_EMAIL || "noreply@thesqua.re", name: "thesqua.re JIT alerts" },
      subject,
      content: [{ type: "text/html", value: alertEmailHtml(env, a, req, ls, total, first, onsPcm) }],
      tracking_settings: { click_tracking: { enable: false } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

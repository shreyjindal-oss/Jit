import type { Env } from "./types";
import { runSearch, validate } from "./pipeline";
import { html } from "./ui";
import { getOns, refreshOns, storeOns } from "./ons";
import { activeIds, deriveSearch, getSearch, listSearches, saveSearch, searchesToday, setArchived } from "./db";
import { createAlert, listAlerts, processAlertsTick, runAlert, stopAlert } from "./alerts";
import { batchCsv, cancelBatch, createBatch, getBatch, listBatches, processBatchTick, retryBatch, TEMPLATE_CSV } from "./batch";

const COOKIE = "jit_auth";

/** One "minute" job: a due alert takes the tick; otherwise one bulk row. Shared by the Workers cron and Cloud Scheduler. */
export async function cronTick(env: Env): Promise<{ alert?: unknown; batch?: unknown }> {
  const a = await processAlertsTick(env).catch((e) => ({ error: String(e?.message ?? e) }) as any);
  if (a?.ran) return { alert: a };
  return { alert: a, batch: await processBatchTick(env) };
}

const COOKIE_DAYS = 180;

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-access-token", ...extra },
  });

function cookieToken(req: Request): string | undefined {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** Token from header, ?token=, or the saved cookie. */
function presented(req: Request): string | null {
  const url = new URL(req.url);
  return req.headers.get("x-access-token") || url.searchParams.get("token") || cookieToken(req) || null;
}

function authorised(req: Request, env: Env): boolean {
  return !env.ACCESS_TOKEN || presented(req) === env.ACCESS_TOKEN;
}

const setCookie = (token: string) =>
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=None; Partitioned` // None+Partitioned so it also works inside an iframe (Enquiry App);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({}, 204);

    if (url.pathname === "/" && request.method === "GET") {
      // Open https://…/?token=XYZ once: the token is saved as a secure cookie and the URL is cleaned.
      const t = url.searchParams.get("token");
      const embed = url.searchParams.get("embed") === "1";
      if (env.ACCESS_TOKEN && t === env.ACCESS_TOKEN) {
        // Share link (…/?token=CODE): sign in via cookie AND keep the code in the browser, so it still works where
        // cookies are blocked (e.g. inside an iframe). The page removes the code from the address bar.
        return new Response(html(false, embed, t), { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": setCookie(t), "referrer-policy": "no-referrer", "cache-control": "no-store" } });
      }
      const needsToken = !!env.ACCESS_TOKEN && cookieToken(request) !== env.ACCESS_TOKEN;
      return new Response(html(needsToken, embed), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        sources: { apify: !!env.APIFY_TOKEN, portals: env.APIFY_PORTALS, propertydata: !!env.PROPERTYDATA_KEY, onsKv: !!env.ONS_KV, db: !!env.DB, enabled: env.ENABLED_SOURCES },
        limits: { maxSearchesPerDay: Number(env.MAX_SEARCHES_PER_DAY || 100), searchesToday: await searchesToday(env).catch(() => null), maxBatchRows: Number(env.MAX_BATCH_ROWS || 50) },
      });
    }
    if (url.pathname === "/api/ons") {
      const d = await getOns(env, true).catch(() => null);
      return json(d ? { period: d.period, release: d.release, fetchedAt: d.fetchedAt, areas: Object.keys(d.areas).length } : { period: null, note: env.ONS_KV ? "no data yet — call /api/ons/refresh" : "ONS_KV binding not set" });
    }
    if (url.pathname === "/api/ons/refresh") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      try {
        return json(await refreshOns(env, url.searchParams.get("force") === "1"));
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 500);
      }
    }
    // Fallback if ONS blocks Cloudflare's servers: upload the xlsx yourself.
    //   curl.exe -X POST ".../api/ons/upload" -H "x-access-token: …" --data-binary "@pipr.xlsx"
    if (url.pathname === "/api/ons/upload" && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      try {
        return json(await storeOns(env, await request.arrayBuffer(), url.searchParams.get("release") || "manual-upload"));
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 500);
      }
    }
    if (url.pathname === "/api/search") {
      if (!authorised(request, env)) return json({ error: "unauthorised — enter the access token" }, 401);
      let body: any;
      if (request.method === "POST") body = await request.json().catch(() => null);
      else if (request.method === "GET") body = Object.fromEntries(url.searchParams);
      else return json({ error: "method not allowed" }, 405);
      const { req, error } = validate(body);
      if (!req) return json({ error }, 400);
      // Cost guard: stop runaway usage (each search ≈ $0.50 of Apify credit).
      const cap = Number(env.MAX_SEARCHES_PER_DAY || 100);
      if ((await searchesToday(env).catch(() => 0)) >= cap) return json({ error: `Daily search limit reached (${cap}). Raise MAX_SEARCHES_PER_DAY in wrangler.toml if needed.` }, 429);
      // First successful use with a typed token -> remember it in a cookie so it's never asked again.
      const extra: Record<string, string> = env.ACCESS_TOKEN && cookieToken(request) !== env.ACCESS_TOKEN ? { "set-cookie": setCookie(env.ACCESS_TOKEN) } : {};
      try {
        const t0 = Date.now();
        const res = await runSearch(req, env);
        const id = await saveSearch(env, res, { source: body?.source === "api" ? "api" : "ui", durationMs: Date.now() - t0 }).catch((e) => {
          res.warnings.push(`Not saved: ${String(e?.message ?? e).slice(0, 120)}`);
          return null;
        });
        return json({ id, ...res }, 200, extra);
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 500);
      }
    }

    // ---- saved searches
    if (url.pathname === "/api/searches" && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      return json({ searches: await listSearches(env, Math.min(500, Number(url.searchParams.get("limit") || 50)), url.searchParams.get("q") || undefined, url.searchParams.get("archived") === "1") });
    }
    const sm = url.pathname.match(/^\/api\/searches\/([\w-]+)$/);
    if (sm && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const s = await getSearch(env, sm[1]);
      return s ? json(s) : json({ error: "not found" }, 404);
    }

    // ---- bulk upload (CSV / XLSX) — processed in the background by the every-minute cron
    if (url.pathname === "/api/template.csv") {
      return new Response(TEMPLATE_CSV, { headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="jit-bulk-template.csv"' } });
    }
    if (url.pathname === "/api/batches" && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      try {
        let buf: ArrayBuffer, name = url.searchParams.get("filename") || "upload";
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("multipart/form-data")) {
          const f = (await request.formData()).get("file") as unknown as File | null;
          if (!f || typeof f === "string") return json({ error: "no file" }, 400);
          buf = await f.arrayBuffer(); name = f.name;
        } else buf = await request.arrayBuffer();
        return json(await createBatch(env, buf, name));
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 400);
      }
    }
    if (url.pathname === "/api/batches" && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      return json({ batches: await listBatches(env) });
    }
    const bm = url.pathname.match(/^\/api\/batches\/([\w-]+)(\.csv)?$/);
    if (bm && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      if (bm[2]) return new Response(await batchCsv(env, bm[1]), { headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="jit-batch-${bm[1].slice(0, 8)}.csv"` } });
      const b = await getBatch(env, bm[1]);
      return b ? json(b) : json({ error: "not found" }, 404);
    }
    const ba = url.pathname.match(/^\/api\/batches\/([\w-]+)\/(cancel|retry)$/);
    if (ba && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      return json(ba[2] === "cancel" ? await cancelBatch(env, ba[1]) : await retryBatch(env, ba[1], url.searchParams.get("empty") === "1"));
    }
    if (url.pathname === "/api/batches/run" && request.method === "POST") {
      // Manual kick (useful locally, where cron doesn't fire): process one tick now.
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      return json(await processBatchTick(env));
    }
    // ---- housekeeping: archive / restore (soft delete) and filtered copies of saved searches
    if ((url.pathname === "/api/archive" || url.pathname === "/api/unarchive") && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const body: any = await request.json().catch(() => ({}));
      const archive = url.pathname === "/api/archive";
      const out: Record<string, number> = {};
      for (const kind of ["searches", "batches", "alerts"] as const) {
        let ids: string[] = Array.isArray(body[kind]) ? body[kind] : [];
        // {"allExcept": {"searches": ["id1", …]}} archives everything else of every kind
        if (archive && body.allExcept) { const keep = new Set<string>(body.allExcept[kind] ?? []); ids = (await activeIds(env, kind)).filter((id) => !keep.has(id)); }
        out[kind] = await setArchived(env, kind, ids, archive);
      }
      return json({ [archive ? "archived" : "restored"]: out });
    }
    const dm = url.pathname.match(/^\/api\/searches\/([\w-]+)\/derive$/);
    if (dm && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const body: any = await request.json().catch(() => ({}));
      const beds = (Array.isArray(body.bedrooms) ? body.bedrooms : [body.bedrooms]).map(Number).filter((b: number) => Number.isInteger(b) && b >= 0 && b <= 6);
      if (!beds.length) return json({ error: "bedrooms required, e.g. [4,5]" }, 400);
      const r = await deriveSearch(env, dm[1], { bedrooms: beds, enquiryRef: body.enquiryRef, clientAccount: body.clientAccount });
      return r ? json(r) : json({ error: "not found" }, 404);
    }
    // ---- scheduled jobs over HTTP (Cloud Scheduler on Cloud Run; also usable by hand anywhere)
    if (url.pathname === "/api/cron/tick" && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      return json(await cronTick(env));
    }
    if (url.pathname === "/api/cron/ons" && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      try { return json(await refreshOns(env)); } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
    }
    // ---- share link: a URL with the access code built in (for signed-in users to hand to colleagues)
    if (url.pathname === "/api/share-link" && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const base = (env.PUBLIC_URL || url.origin).replace(/\/$/, "");
      return json({ url: env.ACCESS_TOKEN ? `${base}/?token=${encodeURIComponent(env.ACCESS_TOKEN)}` : `${base}/`, embedUrl: env.ACCESS_TOKEN ? `${base}/?token=${encodeURIComponent(env.ACCESS_TOKEN)}&embed=1` : `${base}/?embed=1` });
    }
    // ---- alerts
    if (url.pathname === "/api/alerts" && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const r = await createAlert(env, (await request.json().catch(() => ({}))) as any);
      return json(r, r.error ? 400 : 200);
    }
    if (url.pathname === "/api/alerts" && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      return json({ alerts: await listAlerts(env), limits: { maxActive: Number(env.MAX_ACTIVE_ALERTS || 20), maxPerEmail: Number(env.MAX_ALERTS_PER_EMAIL || 3), domains: env.ALERT_EMAIL_DOMAINS || "thesqua.re", email: !!env.SENDGRID_API_KEY } });
    }
    let am = url.pathname.match(/^\/api\/alerts\/([\w-]+)\/(stop|run)$/);
    if (am && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      if (am[2] === "stop") return json({ stopped: await stopAlert(env, am[1]) });
      // Test run: run now without changing the schedule (counts toward the daily cap).
      const a: any = await env.DB?.prepare(`SELECT * FROM alerts WHERE id = ?1`).bind(am[1]).first();
      if (!a) return json({ error: "not found" }, 404);
      if ((await searchesToday(env)) >= Number(env.MAX_SEARCHES_PER_DAY || 100)) return json({ error: "Daily search limit reached" }, 429);
      try {
        const r = await runAlert(env, a);
        await env.DB!.prepare(`UPDATE alerts SET runs=runs+1, emails_sent=emails_sent+?2, last_new_count=?3, last_run_at=?4, last_error=NULL WHERE id=?1`).bind(a.id, r.emailed ? 1 : 0, r.newCount, new Date().toISOString()).run();
        return json(r);
      } catch (e: any) {
        await env.DB!.prepare(`UPDATE alerts SET last_error=?2 WHERE id=?1`).bind(a.id, String(e?.message ?? e).slice(0, 500)).run();
        return json({ error: String(e?.message ?? e) }, 500);
      }
    }
    if (url.pathname === "/alerts/stop" && request.method === "GET") {
      // Public one-click unsubscribe from the email (protected by the per-alert stop token).
      const ok = await stopAlert(env, url.searchParams.get("id") || "", url.searchParams.get("t") || "");
      return new Response(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:40px;max-width:520px;margin:auto"><h2>${ok ? "Alert stopped" : "Alert already stopped or link invalid"}</h2><p>You won't receive further emails for this alert.</p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json({ error: "not found" }, 404);
  },

  /**
   * Cron triggers (wrangler.toml):
   *   "* * * * *"   → process queued bulk-upload rows + run one due alert
   *   "0 6 25 * *"  → try the ONS refresh (the GitHub Action is the reliable path)
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "* * * * *") {
      ctx.waitUntil(cronTick(env).then((r) => console.log("tick", JSON.stringify(r))).catch((e) => console.error("tick failed", String(e?.message ?? e))));
      return;
    }
    ctx.waitUntil(refreshOns(env).then((r) => console.log("ONS refresh", JSON.stringify(r))).catch((e) => console.error("ONS refresh failed", String(e?.message ?? e))));
  },
};

import type { Env } from "./types";
import { runSearch, validate } from "./pipeline";
import { html } from "./ui";
import { getOns, refreshOns, storeOns } from "./ons";
import { getSearch, listSearches, saveSearch, searchesToday } from "./db";
import { batchCsv, createBatch, getBatch, listBatches, processBatchTick, TEMPLATE_CSV } from "./batch";

const COOKIE = "jit_auth";
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
        return new Response(null, { status: 302, headers: { location: embed ? "/?embed=1" : "/", "set-cookie": setCookie(t) } });
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
      return json({ searches: await listSearches(env, Math.min(200, Number(url.searchParams.get("limit") || 50)), url.searchParams.get("q") || undefined) });
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
    if (url.pathname === "/api/batches/run" && request.method === "POST") {
      // Manual kick (useful locally, where cron doesn't fire): process one tick now.
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      return json(await processBatchTick(env));
    }
    return json({ error: "not found" }, 404);
  },

  /**
   * Cron triggers (wrangler.toml):
   *   "* * * * *"   → process queued bulk-upload rows
   *   "0 6 25 * *"  → try the ONS refresh (the GitHub Action is the reliable path)
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "* * * * *") {
      ctx.waitUntil(processBatchTick(env).then((r) => r.processed && console.log("batch tick", JSON.stringify(r))).catch((e) => console.error("batch tick failed", String(e?.message ?? e))));
      return;
    }
    ctx.waitUntil(
      refreshOns(env)
        .then((r) => console.log("ONS refresh", JSON.stringify(r)))
        .catch((e) => console.error("ONS refresh failed", String(e?.message ?? e))),
    );
  },
};

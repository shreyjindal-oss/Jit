import type { Env } from "./types";
import { runSearch, validate } from "./pipeline";
import { html } from "./ui";
import { getOns, refreshOns, storeOns } from "./ons";

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
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({}, 204);

    if (url.pathname === "/" && request.method === "GET") {
      // Open https://…/?token=XYZ once: the token is saved as a secure cookie and the URL is cleaned.
      const t = url.searchParams.get("token");
      if (env.ACCESS_TOKEN && t === env.ACCESS_TOKEN) {
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setCookie(t) } });
      }
      const needsToken = !!env.ACCESS_TOKEN && cookieToken(request) !== env.ACCESS_TOKEN;
      return new Response(html(needsToken), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        sources: { apify: !!env.APIFY_TOKEN, portals: env.APIFY_PORTALS, propertydata: !!env.PROPERTYDATA_KEY, onsKv: !!env.ONS_KV, enabled: env.ENABLED_SOURCES },
      });
    }
    if (url.pathname === "/api/ons") {
      const d = await getOns(env).catch(() => null);
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
      // First successful use with a typed token -> remember it in a cookie so it's never asked again.
      const extra: Record<string, string> = env.ACCESS_TOKEN && cookieToken(request) !== env.ACCESS_TOKEN ? { "set-cookie": setCookie(env.ACCESS_TOKEN) } : {};
      try {
        return json(await runSearch(req, env), 200, extra);
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  },

  /** Monthly cron (wrangler.toml [triggers]): refresh ONS average rents into KV. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshOns(env)
        .then((r) => console.log("ONS refresh", JSON.stringify(r)))
        .catch((e) => console.error("ONS refresh failed", String(e?.message ?? e))),
    );
  },
};

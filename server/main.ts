/**
 * Cloud Run entry point. Runs the same app as the Cloudflare Worker (src/index.ts) on Node 22:
 *   - HTTP: node:http → Fetch Request → worker.fetch(request, env) → Response
 *   - DB / ONS_KV: Postgres (Cloud SQL) via server/pg-adapter.ts
 *   - Cron: Cloud Scheduler POSTs /api/cron/tick (every minute) and /api/cron/ons (monthly)
 *
 * Env vars: everything in wrangler.toml [vars] + the secrets (APIFY_TOKEN, ACCESS_TOKEN, SENDGRID_API_KEY, …) and
 *   DATABASE_URL  e.g. postgres://jit:PASSWORD@/jit?host=/cloudsql/PROJECT:europe-west2:jit-db   (Cloud SQL socket)
 *                 or   postgres://jit:PASSWORD@127.0.0.1:5432/jit                                  (local / proxy)
 *   PORT          set by Cloud Run (default 8080)
 */
import http from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import worker from "../src/index";
import { makeD1, makeKv, type Exec, type Tx } from "./pg-adapter";

// COUNT/SUM come back as bigint/numeric strings by default — the app expects numbers.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [join(here, "migrations-pg"), join(here, "..", "migrations-pg")].find((d) => existsSync(d));

export async function migrate(exec: Exec) {
  if (!MIGRATIONS) throw new Error("migrations-pg folder not found");
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    await exec(readFileSync(join(MIGRATIONS, f), "utf8"), []);
    console.log("migration applied:", f);
  }
}

function envFromProcess(exec: Exec, tx: Tx): any {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^[A-Z][A-Z0-9_]*$/.test(k)) vars[k] = v.trim(); // trim: secrets piped from PowerShell carry a newline
  return { ...vars, DB: makeD1(exec, tx), ONS_KV: makeKv(exec) };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 5) });
  const exec: Exec = async (sql, params) => { const r = await pool.query(sql, params as any[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; };
  const tx: Tx = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(async (sql, params) => { const r = await c.query(sql, params as any[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; });
      await c.query("COMMIT");
      return out;
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  };
  await migrate(exec);
  const env = envFromProcess(exec, tx);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
      const url = `${proto}://${req.headers.host}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const body = req.method === "GET" || req.method === "HEAD" || !chunks.length ? undefined : Buffer.concat(chunks);
      const request = new Request(url, { method: req.method, headers, body });
      const response: Response = await worker.fetch(request, env);
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e: any) {
      console.error("request failed", e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  server.requestTimeout = 0; // long searches / cron ticks; Cloud Run enforces its own timeout
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => console.log(`jit-inventory-sourcer listening on :${port}`));
  const stop = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
export { main };

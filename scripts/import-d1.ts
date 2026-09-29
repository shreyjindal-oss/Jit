/**
 * One-off: copy the Cloudflare D1 data (saved searches, listings, bulk uploads, alerts) into Postgres.
 *
 *   npx wrangler d1 export jit-inventory --remote --no-schema --output d1-data.sql
 *   $env:DATABASE_URL="postgres://jit:PASSWORD@127.0.0.1:5432/jit"   # e.g. via cloud-sql-proxy
 *   npx tsx scripts/import-d1.ts d1-data.sql
 *
 * Safe to re-run (ON CONFLICT DO NOTHING). Creates the tables first if needed.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { migrate } from "../server/main";

const TABLES = ["searches", "listings", "batches", "batch_rows", "alerts", "alert_seen"]; // parents before children
// listings.id is a local serial number: drop D1's value so it can't collide with rows already in Postgres.
const LISTING_COLS = "search_id, rank, portal, url, title, address, outcode, bedrooms, bathrooms, rent_pcm, available_from, furnished, floor, access_fit, access_json, agent_name, agent_phone, lat, lng, distance_miles, score, flags_json, images_json, snippet";

/** SQLite/D1 dump INSERT lines → Postgres statements, in dependency order. */
export function convertDump(sql: string, existingSearchIds: Set<string> = new Set()): string[] {
  const byTable = new Map<string, string[]>(TABLES.map((t) => [t, []]));
  for (const raw of sql.split(/\r?\n/)) {
    const m = raw.match(/^INSERT INTO\s+"?([a-z_]+)"?/i);
    if (!m || !byTable.has(m[1])) continue; // skip d1_migrations, _cf_KV, sqlite_sequence, PRAGMA, BEGIN…
    if (m[1] === "listings") { const sid = raw.match(/VALUES\(\s*\d+\s*,\s*'([^']+)'/)?.[1]; if (sid && existingSearchIds.has(sid)) continue; } // already imported
    const s = raw.trim().replace(/;$/, "")
      .replace(/^INSERT INTO\s+"?([a-z_]+)"?/i, "INSERT INTO $1")
      .replace(/\bchar\((\d+)\)/g, "chr($1)") // sqlite dump encodes newlines as replace('…','\n',char(10))
      .replace(/^INSERT INTO listings VALUES\(\s*\d+\s*,/, `INSERT INTO listings (${LISTING_COLS}) VALUES(`);
    byTable.get(m[1])!.push(m[1] === "listings" ? s : `${s} ON CONFLICT DO NOTHING`);
  }
  return TABLES.flatMap((t) => byTable.get(t)!);
}

async function main() {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error("usage: DATABASE_URL=… npx tsx scripts/import-d1.ts d1-data.sql"); process.exit(1); }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(async (q, p) => { const r = await pool.query(q, p as any[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; });
  const have = new Set((await pool.query(`SELECT id FROM searches`)).rows.map((r) => r.id as string)); // re-runs skip their listings
  const stmts = convertDump(readFileSync(file, "utf8"), have);
  const c = await pool.connect();
  let n = 0;
  try {
    await c.query("BEGIN");
    for (const s of stmts) n += (await c.query(s)).rowCount ?? 0;
    await c.query(`SELECT setval(pg_get_serial_sequence('listings','id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM listings), 1))`);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); await pool.end(); }
  console.log(`imported ${n} rows from ${stmts.length} statements`);
}
if (process.argv[1]?.endsWith("import-d1.ts")) main().catch((e) => { console.error(e); process.exit(1); });

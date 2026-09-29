/**
 * Postgres stand-ins for the two Cloudflare bindings the app uses, so src/ runs unchanged on Cloud Run:
 *   env.DB      — D1-compatible: prepare(sql).bind(...).first() / .all() / .run(), and batch([...]) in one transaction
 *   env.ONS_KV  — KV-compatible: get(key, "json"|"text") / put(key, value), stored in the `kv` table
 *
 * SQL is written once in D1/SQLite dialect and translated here:
 *   ?1, ?2 …                 → $1, $2 …
 *   INSERT OR IGNORE INTO …  → INSERT INTO … ON CONFLICT DO NOTHING
 *   LIKE                     → ILIKE (SQLite LIKE is case-insensitive)
 */

export type Exec = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
export type Tx = <T>(fn: (exec: Exec) => Promise<T>) => Promise<T>;

export function toPg(sql: string): string {
  let s = sql.replace(/\?(\d+)/g, (_, n) => `$${n}`).replace(/\bLIKE\b/g, "ILIKE");
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO").replace(/;?\s*$/, " ON CONFLICT DO NOTHING");
  return s;
}

class Stmt {
  constructor(private exec: Exec, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.exec, this.sql, p.map((v) => (v === undefined ? null : v))); }
  async run(exec: Exec = this.exec) { const r = await exec(toPg(this.sql), this.params); return { success: true, meta: { changes: r.rowCount } }; }
  async first<T = any>(): Promise<T | null> { const r = await this.exec(toPg(this.sql), this.params); return (r.rows[0] as T) ?? null; }
  async all<T = any>(): Promise<{ results: T[]; success: true }> { const r = await this.exec(toPg(this.sql), this.params); return { results: r.rows as T[], success: true }; }
}

export function makeD1(exec: Exec, tx: Tx): any {
  return {
    prepare: (sql: string) => new Stmt(exec, sql),
    batch: (stmts: Stmt[]) => tx(async (e) => { const out = []; for (const s of stmts) out.push(await s.run(e)); return out; }),
  };
}

export function makeKv(exec: Exec): any {
  return {
    async get(key: string, type?: "json" | "text" | { type: string }) {
      const r = await exec(`SELECT value FROM kv WHERE key = $1`, [key]);
      if (!r.rows.length) return null;
      const t = typeof type === "string" ? type : type?.type;
      return t === "json" ? JSON.parse(r.rows[0].value) : r.rows[0].value;
    },
    async put(key: string, value: string) {
      await exec(`INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, typeof value === "string" ? value : JSON.stringify(value), new Date().toISOString()]);
    },
  };
}

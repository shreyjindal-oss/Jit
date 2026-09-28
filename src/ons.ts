import type { Env, GeoPoint } from "./types";

/**
 * ONS "Price Index of Private Rents, UK: monthly price statistics" (free, official, monthly).
 * Average monthly rent per local authority (and region/country), split 1/2/3/4+ bed and flats.
 *
 * refreshOns() is run by the monthly cron (wrangler.toml [triggers]) or POST /api/ons/refresh.
 * It finds the latest release via the ONS page's JSON (/data), downloads the ~19 MB xlsx, streams
 * the ~90 MB sheet XML, keeps only the latest month for each area (~350 areas, ~25 KB) and stores
 * that in KV (binding ONS_KV). Searches read the small KV value.
 */

const ONS_BASE = "https://www.ons.gov.uk";
const DATASET = "/economy/inflationandpriceindices/datasets/priceindexofprivaterentsukmonthlypricestatistics";
const KV_KEY = "ons:pipr:latest";

// [name, region, all, 1bed, 2bed, 3bed, 4+bed, flat]
export type OnsRow = [string, string, number | null, number | null, number | null, number | null, number | null, number | null];
export interface OnsData {
  period: string; // YYYY-MM of the latest month
  release: string; // ONS release URI
  fetchedAt: string;
  areas: Record<string, OnsRow>;
}

export interface OnsBenchmark {
  areaCode: string;
  areaName: string;
  level: "local authority" | "region" | "country";
  period: string;
  bedsLabel: string;
  avgPcm: number;
  allBedsPcm?: number;
  flatPcm?: number;
}

// ---------------------------------------------------------------- minimal zip / xlsx reader

interface ZipEntry { name: string; method: number; csize: number; offset: number }

function zipEntries(buf: ArrayBuffer): ZipEntry[] {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ONS file is not a valid xlsx (no zip directory)");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
    const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.push({ name, method, csize, offset: dataStart });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function entryStream(buf: ArrayBuffer, e: ZipEntry): ReadableStream<string> {
  const raw = new Blob([new Uint8Array(buf, e.offset, e.csize)]).stream();
  const bytes = e.method === 0 ? raw : raw.pipeThrough(new DecompressionStream("deflate-raw"));
  return bytes.pipeThrough(new TextDecoderStream());
}

async function entryText(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  let s = "";
  const r = entryStream(buf, e).getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; s += value; }
  return s;
}

const unxml = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const excelMonth = (v: string): string => {
  const n = Number(v);
  if (Number.isFinite(n) && n > 20000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 7);
  const d = new Date(v);
  return isNaN(+d) ? v : d.toISOString().slice(0, 7);
};

const HEADERS: Record<string, keyof Acc> = {
  "time period": "t", "area code": "code", "area name": "name", "region or country name": "region",
  "rental price": "all", "rental price one bed": "b1", "rental price two bed": "b2", "rental price three bed": "b3",
  "rental price four or more bed": "b4", "rental price flat maisonette": "flat",
};
interface Acc { t: string; code: string; name: string; region: string; all: string; b1: string; b2: string; b3: string; b4: string; flat: string }

/** Parse the PIPR workbook and keep only the latest month per area. Streams the big sheet. */
export async function parsePiprXlsx(buf: ArrayBuffer): Promise<{ period: string; areas: Record<string, OnsRow> }> {
  const entries = zipEntries(buf);
  const ssEntry = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const shared = ssEntry ? [...(await entryText(buf, ssEntry)).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml(m[1])) : [];
  // The data table is by far the largest worksheet.
  const sheet = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => b.csize - a.csize)[0];
  if (!sheet) throw new Error("ONS xlsx has no worksheets");

  const cellRe = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const cellVal = (attrs: string, inner: string | undefined) => {
    if (!inner) return "";
    if (/t="inlineStr"/.test(attrs)) return unxml(inner);
    const v = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "";
    return /t="s"/.test(attrs) ? shared[Number(v)] ?? "" : v;
  };

  let colMap: Record<string, keyof Acc> | null = null;
  const latest = new Map<string, { t: string; row: OnsRow }>();
  const numOrNull = (s: string) => { const n = Number(s); return s !== "" && Number.isFinite(n) ? Math.round(n) : null; };

  const handleRow = (rowXml: string) => {
    const cells: Record<string, string> = {};
    let c: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((c = cellRe.exec(rowXml))) cells[c[1]] = cellVal(c[2], c[3]);
    if (!colMap) {
      const m: Record<string, keyof Acc> = {};
      for (const [col, v] of Object.entries(cells)) { const k = HEADERS[v.trim().toLowerCase()]; if (k) m[col] = k; }
      if (Object.values(m).includes("code") && Object.values(m).includes("b2")) colMap = m;
      return;
    }
    const a = {} as Acc;
    for (const [col, k] of Object.entries(colMap)) a[k] = cells[col] ?? "";
    if (!a.code || !/^[A-Z]\d{8}$/.test(a.code)) return;
    const t = excelMonth(a.t);
    const prev = latest.get(a.code);
    if (prev && prev.t >= t) return;
    latest.set(a.code, { t, row: [a.name, a.region === "[z]" ? "" : a.region, numOrNull(a.all), numOrNull(a.b1), numOrNull(a.b2), numOrNull(a.b3), numOrNull(a.b4), numOrNull(a.flat)] });
  };

  const reader = entryStream(buf, sheet).getReader();
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) tail += value;
    let start = 0;
    for (;;) {
      const open = tail.indexOf("<row", start);
      if (open < 0) { start = tail.length; break; }
      const close = tail.indexOf("</row>", open);
      if (close < 0) { start = open; break; }
      handleRow(tail.slice(open, close));
      start = close + 6;
    }
    tail = tail.slice(start);
    if (done) break;
  }
  if (!colMap) throw new Error("ONS sheet header not recognised (expected 'Area code', 'Rental price two bed', …)");
  if (!latest.size) throw new Error("ONS sheet had no rows");
  const period = [...latest.values()].reduce((m, v) => (v.t > m ? v.t : m), "");
  return { period, areas: Object.fromEntries([...latest].map(([k, v]) => [k, v.row])) };
}

// ---------------------------------------------------------------- refresh + read

// ONS's CDN rejects requests that don't look like a normal browser download (403).
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  "accept-language": "en-GB,en;q=0.9",
};

async function onsJson(path: string): Promise<any> {
  const r = await fetch(`${ONS_BASE}${path}/data`, { headers: { ...BROWSER_HEADERS, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`ONS ${path}: ${r.status}`);
  return r.json();
}

/** Fetch the latest ONS release and store it in KV. Skips work if the release is unchanged (unless force). */
export async function refreshOns(env: Env, force = false): Promise<{ updated: boolean; period?: string; release: string; areas?: number }> {
  if (!env.ONS_KV) throw new Error("ONS_KV binding missing — create the KV namespace (see README)");
  const page = await onsJson(DATASET);
  const release: string | undefined = page?.datasets?.[0]?.uri;
  if (!release) throw new Error("ONS: no releases listed");
  const current = await getOns(env, true);
  if (!force && current?.release === release) return { updated: false, period: current.period, release };
  const rel = await onsJson(release);
  const file = rel?.downloads?.find((d: any) => /\.xlsx$/i.test(d.file))?.file;
  if (!file) throw new Error("ONS: release has no xlsx download");
  const r = await fetch(`${ONS_BASE}/file?uri=${release}/${file}`, {
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
      referer: `${ONS_BASE}${DATASET}`,
    },
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`ONS download ${r.status} — if this persists, upload the file instead: POST /api/ons/upload (see README)`);
  return storeOns(env, await r.arrayBuffer(), release);
}

/** Parse an xlsx (downloaded or uploaded) and save it to KV. */
export async function storeOns(env: Env, buf: ArrayBuffer, release: string): Promise<{ updated: boolean; period: string; release: string; areas: number }> {
  if (!env.ONS_KV) throw new Error("ONS_KV binding missing — create the KV namespace (see README)");
  const parsed = await parsePiprXlsx(buf);
  const data: OnsData = { ...parsed, release, fetchedAt: new Date().toISOString() };
  await env.ONS_KV.put(KV_KEY, JSON.stringify(data));
  cache = { data, at: Date.now() };
  return { updated: true, period: data.period, release, areas: Object.keys(data.areas).length };
}

// Small in-memory cache per Worker instance. Short TTL so a new upload (from another instance or the
// GitHub Action) is picked up within minutes; `fresh` bypasses it.
let cache: { data: OnsData | null; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;
export async function getOns(env: Env, fresh = false): Promise<OnsData | null> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!env.ONS_KV) return null;
  const v = (await env.ONS_KV.get(KV_KEY, "json")) as OnsData | null;
  cache = { data: v ?? null, at: Date.now() };
  return cache.data;
}

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/,? city of|county of|&/g, "").replace(/[^a-z]/g, "");

/** Match the enquiry location to an ONS area: local authority → region → country. */
export function onsLookup(data: OnsData, geo: GeoPoint, bedrooms: number): OnsBenchmark | null {
  const idx = bedrooms <= 1 ? 3 : bedrooms === 2 ? 4 : bedrooms === 3 ? 5 : 6;
  const bedsLabel = bedrooms === 0 ? "1 bed (studio proxy)" : bedrooms >= 4 ? "4+ bed" : `${bedrooms} bed`;
  const byName = (name?: string, prefix?: RegExp) =>
    name ? Object.entries(data.areas).find(([code, r]) => (!prefix || prefix.test(code)) && norm(r[0]) === norm(name)) : undefined;

  const candidates: [string, OnsRow, OnsBenchmark["level"]][] = [];
  const push = (e: [string, OnsRow] | undefined, level: OnsBenchmark["level"]) => { if (e && e[1][idx] != null) candidates.push([e[0], e[1], level]); };
  if (geo.laCode && data.areas[geo.laCode]) push([geo.laCode, data.areas[geo.laCode]], "local authority");
  push(byName(geo.district ?? geo.town, /^[EWS]0[6-9]|^S33/), "local authority");
  push(byName(geo.region, /^E12/), "region");
  push(byName(geo.country), "country");
  const hit = candidates[0];
  if (!hit) return null;
  const [code, row, level] = hit;
  return { areaCode: code, areaName: row[0], level, period: data.period, bedsLabel, avgPcm: row[idx]!, allBedsPcm: row[2] ?? undefined, flatPcm: row[7] ?? undefined };
}

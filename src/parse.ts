/** Text helpers for pulling rent / beds / baths / dates out of listing titles & snippets. */

export function parseRentPcm(text: string | undefined): { pcm?: number; raw?: string } {
  if (!text) return {};
  const m = text.match(/£\s?([\d,]+(?:\.\d{1,2})?)\s*(pcm|p\.?c\.?m\.?|per\s*calendar\s*month|per\s*month|\/\s*month|a\s*month|pw|p\.?w\.?|per\s*week|\/\s*week|a\s*week)?/i);
  if (!m) return {};
  const amount = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(amount) || amount <= 0) return {};
  const unit = (m[2] || "").toLowerCase();
  const weekly = /w|week/.test(unit) && !/month/.test(unit);
  // Heuristic: unlabelled amounts under £1,000 in a lettings context are usually weekly (London) — but
  // we only convert when explicitly weekly to avoid guessing. Sale prices (>£50k) are ignored.
  if (!unit && amount > 50000) return {};
  const pcm = weekly ? Math.round((amount * 52) / 12) : Math.round(amount);
  return { pcm, raw: m[0].trim() };
}

export function parseBedrooms(text: string | undefined): number | undefined {
  if (!text) return undefined;
  if (/\bstudio\b/i.test(text)) return 0;
  const m = text.match(/(\d{1,2})\s*[- ]?\s*(?:bed(?:room)?s?|br)\b/i);
  return m ? parseInt(m[1], 10) : undefined;
}

export function parseBathrooms(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d{1,2})\s*[- ]?\s*bath(?:room)?s?\b/i);
  return m ? parseInt(m[1], 10) : undefined;
}

export function parseFurnished(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (/\bunfurnished\b/i.test(text)) return "Unfurnished";
  if (/\bpart[- ]furnished\b/i.test(text)) return "Part furnished";
  if (/\bfurnished\b/i.test(text)) return "Furnished";
  return undefined;
}

export function parseAvailable(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (/available\s*(now|immediately)/i.test(text)) return "Now";
  const m = text.match(/available\s*(?:from)?\s*:?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s*\d{0,4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return m ? m[1].trim() : undefined;
}

export function parsePhone(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/(?:\+44\s?|0)(?:\d\s?){9,10}/);
  return m ? m[0].trim() : undefined;
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[£,\s]/g, ""));
  return isFinite(n) ? n : undefined;
}

/** Last UK postcode district in a string, e.g. "Bryant Street, Stratford, E15" -> "E15". */
export function parseOutcode(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const re = /\b([A-Z]{1,2}\d[A-Z\d]?)(?:\s+\d[A-Z]{2})?\b/g;
  let m: RegExpExecArray | null, last: string | undefined;
  while ((m = re.exec(text))) last = m[1];
  return last;
}

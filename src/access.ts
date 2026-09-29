/**
 * Accessibility + floor detection from listing text (title, summary, description, key features).
 * None of Rightmove / Zoopla / OnTheMarket / OpenRent offers a reliable accessibility filter, so we
 * read what agents write. Results are "signals" to verify with the agent, not guarantees.
 */

export type AccessNeed = "any" | "ground_floor" | "step_free" | "wheelchair";

export interface AccessInfo {
  floor?: string; // "Ground", "Lower ground", "1st", "Top", "Bungalow", ...
  floorLevel?: number; // 0 = ground, -1 = lower ground, n = nth floor; undefined if unknown
  features: string[]; // human-readable signals found
  groundFloor: boolean;
  lift: boolean;
  stepFree: boolean; // ground floor / bungalow / lift + level access
  wheelchair: boolean;
}

const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

const SIGNALS: [RegExp, string][] = [
  [/\bwheelchair[- ](?:accessible|access|friendly|user)/i, "wheelchair accessible"],
  [/\bstep[- ]?free\b|\bno (?:steps|stairs)\b|\blevel (?:access|entry|threshold)/i, "step-free / level access"],
  [/\b(?:passenger |residents'? )?lifts?\b(?! and shift)|\belevator\b/i, "lift"],
  [/\bramp(?:ed)? access\b|\baccess ramp\b/i, "ramp"],
  [/\bwet ?room\b|\bwalk[- ]in shower\b|\broll[- ]in shower\b|\blevel[- ]access shower\b/i, "wet room / walk-in shower"],
  [/\bgrab rails?\b|\bdisabled (?:access|adapted|facilities)\b|\badapted (?:property|home|bathroom)\b/i, "adapted"],
  [/\bbungalow\b/i, "bungalow"],
  [/\bground floor\b/i, "ground floor"],
];

export function detectAccess(...texts: (string | undefined | null)[]): AccessInfo {
  const t = texts.filter(Boolean).join(" \n ").replace(/\s+/g, " ");
  const features = SIGNALS.filter(([re]) => re.test(t)).map(([, label]) => label);
  let floor: string | undefined;
  let floorLevel: number | undefined;

  if (/\bbungalow\b/i.test(t)) { floor = "Bungalow"; floorLevel = 0; }
  else if (/\blower[- ]ground(?: floor)?\b|\bbasement (?:flat|apartment)\b/i.test(t)) { floor = "Lower ground"; floorLevel = -1; }
  else if (/\b(?:raised )?ground[- ]floor (?:flat|apartment|maisonette|property|studio|unit)\b|\blocated on the ground floor\b|\bon the ground floor\b/i.test(t)) { floor = "Ground"; floorLevel = 0; }
  else {
    const m = t.match(/\b(\d{1,2})(?:st|nd|rd|th) floor\b/i) || t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) floor\b/i);
    if (m) { floorLevel = /\d/.test(m[1]) ? parseInt(m[1], 10) : ORD[m[1].toLowerCase()]; floor = ordinal(floorLevel); }
    else if (/\b(?:top|upper)[- ]floor\b|\bpenthouse\b/i.test(t)) { floor = "Top/upper"; floorLevel = 99; }
    else if (/\bground floor\b/i.test(t)) { floor = "Ground (mentioned)"; } // e.g. "ground floor living room" in a house — ambiguous
  }

  const lift = features.includes("lift");
  const groundFloor = floorLevel === 0;
  const wheelchair = features.includes("wheelchair accessible");
  const stepFree = groundFloor || wheelchair || features.includes("step-free / level access");
  return { floor, floorLevel, features, groundFloor, lift, stepFree, wheelchair };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * How well a listing fits the accessibility need.
 *  "fit"      → matches (e.g. ground floor for ground_floor; step-free/lift for step_free)
 *  "unknown"  → listing doesn't say — keep but flag "check access"
 *  "no"       → clearly doesn't fit (e.g. 3rd floor, no lift mentioned, for step_free)
 */
export function accessFit(a: AccessInfo, need: AccessNeed): "fit" | "unknown" | "no" {
  if (need === "any") return "fit";
  const upper = a.floorLevel !== undefined && a.floorLevel > 0;
  if (need === "ground_floor") {
    if (a.groundFloor) return "fit";
    if (upper || a.floorLevel === -1) return "no";
    return "unknown";
  }
  if (need === "step_free") {
    if (a.groundFloor || a.stepFree || a.wheelchair) return "fit";
    if (upper && a.lift) return "fit";
    if (upper && !a.lift) return "no";
    if (a.floorLevel === -1) return "no";
    return "unknown";
  }
  // wheelchair
  if (a.wheelchair || (a.stepFree && a.features.includes("wet room / walk-in shower"))) return "fit";
  if (upper && !a.lift) return "no";
  if (a.floorLevel === -1) return "no";
  return "unknown";
}

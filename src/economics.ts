import type { Economics, Listing, MarketBenchmark, SearchRequest } from "./types";

const DAY = 86400000;

export function nightsBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Stay vs lease economics: the lease usually outlasts the enquiry, so show the void risk. */
export function economics(req: SearchRequest, minLeaseMonths: number, bench?: MarketBenchmark, listings: Listing[] = [], onsPcm?: number): Economics {
  const nights = nightsBetween(req.checkIn, req.checkOut);
  const stayMonths = Math.round((nights / 30.44) * 10) / 10;
  const leaseMonths = Math.max(minLeaseMonths, Math.ceil(nights / 30.44));
  const notes: string[] = [];
  const observed = median(listings.filter((l) => l.kind === "listing" && l.rentPcm && l.bedrooms === req.bedrooms && !l.flags.includes("area unverified")).map((l) => l.rentPcm!));
  // Rent basis: PropertyData benchmark → median of live listings → ONS area average.
  const rent = bench?.avgPcm ?? observed ?? onsPcm;
  const e: Economics = {
    nights,
    stayMonths,
    leaseMonths,
    leaseExceedsStay: leaseMonths > stayMonths,
    voidMonths: Math.max(0, Math.round((leaseMonths - stayMonths) * 10) / 10),
    benchmarkRentPcm: rent,
    notes,
  };
  if (e.leaseExceedsStay) {
    notes.push(`Stay is ${stayMonths} months; a typical lease is ${leaseMonths}+ months — ~${e.voidMonths} months need follow-on bookings (void risk). Try negotiating a ${Math.ceil(stayMonths)}-month company let or a break clause.`);
  }
  if (!bench?.avgPcm && observed) notes.push("Rent basis = median of live listings found.");
  else if (!bench?.avgPcm && !observed && onsPcm) notes.push("Rent basis = ONS area average (no matching live listings with a rent).");
  if (rent) {
    e.leaseCost = Math.round(rent * leaseMonths + (req.setupCost ?? 0));
    e.breakEvenNightlyStayOnly = nights > 0 ? Math.round(e.leaseCost / nights) : undefined;
    if (req.sellRateNightly) {
      e.revenue = Math.round(req.sellRateNightly * nights);
      const stayCost = Math.round(rent * Math.max(stayMonths, 1) + (req.setupCost ?? 0));
      e.margin = e.revenue - stayCost;
      e.marginPct = e.revenue ? Math.round((e.margin / e.revenue) * 1000) / 10 : undefined;
      notes.push(`Margin uses rent for the stay period only (${Math.max(stayMonths, 1)} mo) + setup; the remaining lease must be re-let.`);
    }
  }
  return e;
}

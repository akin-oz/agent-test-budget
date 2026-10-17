export type Tier = { upTo: number | null; unitCents: number };
export type Coupon = { kind: 'percent' | 'fixed'; value: number; stackable: boolean };

/** Graduated pricing: each unit is charged at the rate of the tier it falls in. `upTo: null` is open-ended. */
export function tieredCost(units: number, tiers: Tier[]): number {
  if (!Number.isInteger(units) || units < 0) throw new RangeError('units must be a non-negative integer');
  if (!tiers.length) throw new Error('no tiers');
  let cost = 0;
  let prev = 0;
  for (const t of tiers) {
    if (units <= prev) break;
    const cap = t.upTo ?? Infinity;
    const n = Math.min(units, cap) - prev;
    cost += n * t.unitCents;
    prev = cap;
  }
  if (units > prev) throw new Error('units exceed the last tier');
  return cost;
}

/** Tax in cents, rounded half away from zero (so a refund rounds like a charge). */
export function taxCents(netCents: number, ratePercent: number): number {
  if (ratePercent < 0) throw new RangeError('rate must be >= 0');
  const raw = (netCents * ratePercent) / 100;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

/** Coupons apply in order: percent ones compound, fixed ones subtract, only the first non-stackable one counts. Never below zero. */
export function applyCoupons(cents: number, coupons: Coupon[]): number {
  let total = cents;
  let exclusiveUsed = false;
  for (const c of coupons) {
    if (!c.stackable) {
      if (exclusiveUsed) continue;
      exclusiveUsed = true;
    }
    total = c.kind === 'percent' ? Math.round(total * (1 - c.value / 100)) : total - c.value;
  }
  return Math.max(0, total);
}

/** Final price: tiered cost, then coupons, then tax on the discounted amount. */
export function quote(units: number, tiers: Tier[], coupons: Coupon[], taxRate: number) {
  const net = applyCoupons(tieredCost(units, tiers), coupons);
  const tax = taxCents(net, taxRate);
  return { net, tax, gross: net + tax };
}

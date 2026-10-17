/** Integer-cents money helpers. Never uses floating point for amounts. */
export function formatMoney(cents: number, currency = 'USD', locale = 'en-US'): string {
  if (!Number.isInteger(cents)) throw new TypeError('cents must be an integer');
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function parseMoney(text: string): number {
  const m = /^\s*(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) throw new Error(`cannot parse money: ${text}`);
  const whole = Number(m[2].replace(/,/g, ''));
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  return m[1] ? -cents : cents;
}

/** Split an amount into n parts that differ by at most one cent and sum exactly to the total. */
export function splitEvenly(cents: number, n: number): number[] {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer');
  const base = Math.trunc(cents / n);
  const extra = Math.abs(cents) - Math.abs(base) * n;
  const sign = cents < 0 ? -1 : 1;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? sign : 0));
}

export type Discount = { code: string; kind: 'percent' | 'fixed'; value: number; minSubtotal?: number };
type Line = { sku: string; unitCents: number; qty: number; stock: number };

export class Cart {
  private lines = new Map<string, Line>();
  private discount: Discount | null = null;

  add(sku: string, unitCents: number, qty = 1, stock = Infinity): void {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError('qty must be a positive integer');
    const cur = this.lines.get(sku);
    const next = (cur?.qty ?? 0) + qty;
    if (next > (cur?.stock ?? stock)) throw new Error(`not enough stock for ${sku}`);
    this.lines.set(sku, { sku, unitCents, qty: next, stock: cur?.stock ?? stock });
  }

  remove(sku: string, qty = Infinity): void {
    const cur = this.lines.get(sku);
    if (!cur) return;
    if (qty >= cur.qty) this.lines.delete(sku);
    else this.lines.set(sku, { ...cur, qty: cur.qty - qty });
  }

  apply(d: Discount | null): void {
    if (d && d.kind === 'percent' && (d.value < 0 || d.value > 100)) throw new RangeError('percent must be 0-100');
    this.discount = d;
  }

  subtotal(): number {
    let t = 0;
    for (const l of this.lines.values()) t += l.unitCents * l.qty;
    return t;
  }

  discountCents(): number {
    const d = this.discount;
    const sub = this.subtotal();
    if (!d || sub === 0 || (d.minSubtotal !== undefined && sub < d.minSubtotal)) return 0;
    const raw = d.kind === 'percent' ? Math.round((sub * d.value) / 100) : d.value;
    return Math.min(raw, sub);
  }

  total(): number {
    return this.subtotal() - this.discountCents();
  }

  count(): number {
    let n = 0;
    for (const l of this.lines.values()) n += l.qty;
    return n;
  }
}

import { describe, it, expect } from 'vitest';
import { add, neg } from './add';

describe('add', () => {
  it('adds', () => { expect(add(1, 2)).toBe(3); });
  it('negates', () => { expect(neg(1)).toBe(-1); });
});

const { add, neg } = require('./add');

describe('add', () => {
  it('adds', () => { expect(add(1, 2)).toBe(3); });
  it('negates', () => { expect(neg(1)).toBe(-1); });
});

import { BRAND } from '@/lib/brand';

describe('brand', () => {
  it('uses the platform WeldAgent violet', () => {
    expect(BRAND).toBe('#8d65ef');
  });
});

// The tablet hooks read screen width from RN's `useWindowDimensions`. They call
// no real React hooks themselves, so once `useWindowDimensions` is stubbed with
// a plain function we can invoke them directly — no renderer required.
const mockUseWindowDimensions = jest.fn();

jest.mock('react-native', () => ({
  useWindowDimensions: () => mockUseWindowDimensions(),
}));

import { useIsTablet, useTabletScale } from '../tablet';

describe('tablet hooks', () => {
  beforeEach(() => {
    mockUseWindowDimensions.mockReset();
  });

  const setWidth = (width: number) =>
    mockUseWindowDimensions.mockReturnValue({ width, height: 1000, scale: 2, fontScale: 1 });

  describe('useIsTablet', () => {
    it('returns false just below the 768px threshold', () => {
      setWidth(767);
      expect(useIsTablet()).toBe(false);
    });

    it('returns true at exactly 768px (inclusive boundary)', () => {
      setWidth(768);
      expect(useIsTablet()).toBe(true);
    });

    it('returns true well above the threshold', () => {
      setWidth(1024);
      expect(useIsTablet()).toBe(true);
    });

    it('returns false for a narrow phone width', () => {
      setWidth(390);
      expect(useIsTablet()).toBe(false);
    });
  });

  describe('useTabletScale', () => {
    it('returns the base value unchanged on phones', () => {
      setWidth(390);
      const scale = useTabletScale();
      expect(scale(16)).toBe(16);
      expect(scale(0)).toBe(0);
    });

    it('scales by the default 1.25 factor on tablets', () => {
      setWidth(820);
      const scale = useTabletScale();
      expect(scale(16)).toBe(20); // 16 * 1.25
    });

    it('rounds the scaled value to the nearest integer', () => {
      setWidth(820);
      const scale = useTabletScale();
      expect(scale(10)).toBe(13); // 10 * 1.25 = 12.5 -> rounds to 13
    });

    it('honors a custom scale factor on tablets', () => {
      setWidth(820);
      const scale = useTabletScale(2);
      expect(scale(16)).toBe(32);
    });

    it('ignores the custom scale factor on phones', () => {
      setWidth(390);
      const scale = useTabletScale(2);
      expect(scale(16)).toBe(16);
    });
  });
});

import {
  resolveIndicatorLayout,
  shouldMoveIndicatorForLayout,
  upsertTabLayout,
} from '../../../../packages/design/mobile-ui/src/utils/floatingTabBarState';

describe('floatingTabBarState', () => {
  it('keeps sibling layouts when multiple tabs measure in sequence', () => {
    const layouts: Record<number, { x: number; width: number }> = {};

    upsertTabLayout(layouts, 0, { x: 0, width: 80 });
    upsertTabLayout(layouts, 1, { x: 80, width: 80 });
    upsertTabLayout(layouts, 2, { x: 160, width: 80 });
    upsertTabLayout(layouts, 3, { x: 240, width: 80 });

    expect(Object.keys(layouts)).toHaveLength(4);
    expect(resolveIndicatorLayout(layouts, 3)).toEqual({ x: 240, width: 80 });
    expect(resolveIndicatorLayout(layouts, 1)).toEqual({ x: 80, width: 80 });
  });

  it('returns null until the active tab has been measured', () => {
    const layouts: Record<number, { x: number; width: number }> = {};
    upsertTabLayout(layouts, 0, { x: 0, width: 80 });

    expect(resolveIndicatorLayout(layouts, 2)).toBeNull();
  });

  it('moves the indicator only for the live active index', () => {
    expect(shouldMoveIndicatorForLayout(3, 1)).toBe(false);
    expect(shouldMoveIndicatorForLayout(1, 1)).toBe(true);
  });

  it('simulates the stuck-pill race: late layout for an old tab must not win', () => {
    const layouts: Record<number, { x: number; width: number }> = {};
    let activeIndex = 3;
    let indicator: { x: number; width: number } | null = null;

    const applyLayout = (index: number, x: number, width: number) => {
      upsertTabLayout(layouts, index, { x, width });
      if (shouldMoveIndicatorForLayout(index, activeIndex)) {
        indicator = { x, width };
      }
    };

    applyLayout(0, 0, 80);
    applyLayout(1, 80, 80);
    applyLayout(2, 160, 80);
    applyLayout(3, 240, 80);
    expect(indicator).toEqual({ x: 240, width: 80 });

    activeIndex = 1;
    indicator = resolveIndicatorLayout(layouts, activeIndex);
    expect(indicator).toEqual({ x: 80, width: 80 });

    applyLayout(3, 240, 80);
    expect(indicator).toEqual({ x: 80, width: 80 });
  });
});

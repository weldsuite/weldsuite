/**
 * Pure helpers for the floating tab indicator.
 *
 * Layouts live in a mutable map (not a Reanimated shared-object spread) so
 * concurrent onLayout callbacks cannot drop sibling measurements - the race
 * that left the pill highlight on the wrong tab after a route change.
 */

export type TabLayout = { x: number; width: number };

/** Write one tab's layout into the map. Mutates and returns the same map. */
export function upsertTabLayout(
  layouts: Record<number, TabLayout>,
  index: number,
  layout: TabLayout,
): Record<number, TabLayout> {
  layouts[index] = layout;
  return layouts;
}

/** Look up the indicator frame for the active tab, if measured. */
export function resolveIndicatorLayout(
  layouts: Readonly<Record<number, TabLayout>>,
  activeIndex: number,
): TabLayout | null {
  return layouts[activeIndex] ?? null;
}

/**
 * Decide whether a layout event should move the indicator.
 * Always compare against the live active index (ref), never a stale closure.
 */
export function shouldMoveIndicatorForLayout(
  layoutIndex: number,
  activeIndex: number,
): boolean {
  return layoutIndex === activeIndex;
}

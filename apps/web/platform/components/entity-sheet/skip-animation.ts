/**
 * One-shot flag that suppresses the entity sheet's slide-in animation on the
 * next mount.
 *
 * Set by callers that are already showing a panel in the same screen slot
 * (e.g. WeldChat clicking an `@customer` mention while the members panel is
 * open) — swapping one panel for another should be instant, not animated.
 *
 * Read by the renderers (`EntitySheetShell`, `CustomerDetailView`) at first
 * render via a `useState` lazy initializer, so the flag is consumed exactly
 * once per mount.
 */

let skip = false;

export function flagSkipNextEntitySheetAnimation() {
  skip = true;
}

export function consumeSkipNextEntitySheetAnimation(): boolean {
  const v = skip;
  skip = false;
  return v;
}

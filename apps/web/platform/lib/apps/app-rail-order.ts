/**
 * Order bookkeeping for the app rail.
 *
 * The rail keeps a "known" order of every app code it has shown this session,
 * including apps that have since been uninstalled. An uninstalled app keeps
 * its slot, so reinstalling it puts it back where it was instead of at the
 * bottom (where an order built only from the visible apps would put it).
 */

/**
 * Add codes from `visible` (in the server's order) that `known` hasn't seen
 * yet. A new code goes right after the nearest code before it in `visible`
 * that `known` already has, or first when there is none.
 */
export function rememberAppCodes(known: readonly string[], visible: readonly string[]): string[] {
  const out = [...known];
  for (let i = 0; i < visible.length; i++) {
    const code = visible[i];
    if (out.includes(code)) continue;
    let insertAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.indexOf(visible[j]);
      if (idx !== -1) {
        insertAt = idx + 1;
        break;
      }
    }
    out.splice(insertAt, 0, code);
  }
  return out;
}

/**
 * Apply a reordering of the visible apps to the known order: the slots the
 * visible codes held are refilled in their new order, hidden (uninstalled)
 * codes keep their slots.
 */
export function applyVisibleOrder(known: readonly string[], reordered: readonly string[]): string[] {
  const visible = new Set(reordered);
  const queue = [...reordered];
  const out = known.map((code) => (visible.has(code) ? (queue.shift() as string) : code));
  // Codes the known order lacked go last (never expected; keeps nothing lost).
  return [...out, ...queue];
}

/** Sort `apps` by `order`; apps missing from it keep their relative order at the end. */
export function sortByAppOrder<T extends { appCode: string }>(apps: readonly T[], order: readonly string[]): T[] {
  if (!order.length) return [...apps];
  const rank = new Map(order.map((code, i) => [code, i]));
  return apps
    .map((app, i) => ({ app, i }))
    .sort((a, b) => {
      const ra = rank.get(a.app.appCode) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.app.appCode) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || a.i - b.i;
    })
    .map(({ app }) => app);
}

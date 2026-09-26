/**
 * Empty shim for react — not used in API workers.
 * This prevents the bundler from including React (pulled in by @weldsuite/db auth helpers).
 */

export const cache = <T extends (...args: unknown[]) => unknown>(fn: T): T => fn;

export default {};

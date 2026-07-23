/**
 * Empty shim for react - not used in external-api
 * This prevents the bundler from including React dependencies
 */

// React cache function - provide a simple pass-through implementation
export const cache = <T extends (...args: unknown[]) => unknown>(fn: T): T => fn;

export default {};

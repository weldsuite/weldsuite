/**
 * Empty shim for react - not used in mcp-server
 * This prevents the bundler from including React dependencies
 */

export const cache = <T extends (...args: unknown[]) => unknown>(fn: T): T => fn;

export default {};

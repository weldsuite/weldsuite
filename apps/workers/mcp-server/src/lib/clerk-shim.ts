/**
 * Empty shim for @clerk/nextjs - not used in mcp-server
 * This prevents the bundler from including Clerk's dependencies
 */

export const auth = () => {
  throw new Error('Clerk auth is not available in mcp-server. Use API key authentication.');
};

export const clerkClient = () => {
  throw new Error('Clerk client is not available in mcp-server.');
};

export default {};

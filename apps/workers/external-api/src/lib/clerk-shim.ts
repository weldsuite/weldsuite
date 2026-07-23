/**
 * Empty shim for @clerk/nextjs - not used in external-api
 * This prevents the bundler from including Clerk's dependencies
 */

// Clerk auth functions - not used in external-api (uses API key auth instead)
export const auth = () => {
  throw new Error('Clerk auth is not available in external-api. Use API key authentication.');
};

export const clerkClient = () => {
  throw new Error('Clerk client is not available in external-api.');
};

export default {};

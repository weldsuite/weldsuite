/**
 * Empty shim for next/server and next/navigation — not used in API workers.
 * This prevents the bundler from including Next.js Node dependencies.
 */

export const redirect = (_url: string): never => {
  throw new Error('next/navigation is not available in API workers.');
};

export default {};

/**
 * Empty shim for next/server and next/navigation — not used in app-api.
 * This prevents the bundler from including Next.js Node dependencies.
 */

export const redirect = (_url: string): never => {
  throw new Error('next/navigation is not available in app-api.');
};

export default {};

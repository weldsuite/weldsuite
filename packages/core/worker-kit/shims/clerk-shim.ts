/**
 * Empty shim for @clerk/nextjs — not used in API workers.
 * Auth goes through @clerk/backend (@weldsuite/worker-kit/middleware/clerk).
 * This prevents the bundler from including Clerk's Next.js / Node deps.
 */

export const auth = () => {
  throw new Error(
    'Clerk Next.js auth is not available in API workers. Use @clerk/backend.',
  );
};

export const clerkClient = () => {
  throw new Error(
    'Clerk Next.js client is not available in API workers. Use @clerk/backend.',
  );
};

export default {};

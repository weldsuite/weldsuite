/**
 * Empty shim for @clerk/nextjs — not used in app-api.
 * Auth goes through @clerk/backend (see middleware/clerk.ts).
 * This prevents the bundler from including Clerk's Next.js / Node deps.
 */

export const auth = () => {
  throw new Error(
    'Clerk Next.js auth is not available in app-api. Use @clerk/backend.',
  );
};

export const clerkClient = () => {
  throw new Error(
    'Clerk Next.js client is not available in app-api. Use @clerk/backend.',
  );
};

export default {};

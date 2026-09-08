/**
 * Empty shim for @clerk/nextjs — not used in helpdesk-widget-api.
 * Widget auth uses widget API keys. This prevents the bundler from including
 * Clerk's Next.js / Node deps (`__dirname`) when `@weldsuite/db/lib` is imported.
 */

export const auth = () => {
  throw new Error(
    'Clerk Next.js auth is not available in helpdesk-widget-api. Use widget API key auth.',
  );
};

export const clerkClient = () => {
  throw new Error(
    'Clerk Next.js client is not available in helpdesk-widget-api.',
  );
};

export default {};

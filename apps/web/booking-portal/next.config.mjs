/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@weldsuite/ui"],
  typescript: {
    // NOTE: kept on because `@weldsuite/db` and `@weldsuite/permissions` have
    // pre-existing type errors that every Next.js app in this monorepo dodges
    // the same way (admin, meeting-portal, parcel-* portals all set this flag).
    // The booking-portal's own files ARE type-checked via `pnpm type-check`.
    // Remove this when the upstream packages are clean.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

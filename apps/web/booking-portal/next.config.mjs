/** @type {import('next').NextConfig} */
const nextConfig = {
  // meet-domain ships TS sources (WeldMeet meetings for bookings); emails +
  // its own workspace deps (email, i18n) ship raw .ts/.tsx too.
  transpilePackages: [
    "@weldsuite/ui",
    "@weldsuite/meet-domain",
    "@weldsuite/emails",
    "@weldsuite/email",
    "@weldsuite/i18n",
    "@weldsuite/text",
  ],
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

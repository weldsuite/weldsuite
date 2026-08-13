/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TS (no build step), so Next has to transpile
  // them itself — otherwise `next build` can't resolve '@weldsuite/ui/components/*'
  // or the extensioned relative re-exports inside transactional-email
  // (`export * from './resend.js'`). Mirrors apps/web/sites.
  transpilePackages: ['@weldsuite/ui', '@weldsuite/transactional-email', '@weldsuite/realtime-registrar'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
};

export default nextConfig;

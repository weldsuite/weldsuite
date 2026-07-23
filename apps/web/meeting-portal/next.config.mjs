/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@weldsuite/df3-noise-suppression', '@weldsuite/cloudflare-realtime'],
  typescript: {
    ignoreBuildErrors: true,
  },
  async headers() {
    return [
      {
        // Apply to every route in the meeting portal.
        source: '/(.*)',
        headers: [
          // Allow getDisplayMedia (screen capture) on this origin.
          // Without this header some browsers (Safari TP, Chromium with strict
          // site isolation) refuse navigator.mediaDevices.getDisplayMedia and
          // throw a NotAllowedError before the browser picker even opens.
          {
            key: 'Permissions-Policy',
            value: 'display-capture=(self), camera=(self), microphone=(self)',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

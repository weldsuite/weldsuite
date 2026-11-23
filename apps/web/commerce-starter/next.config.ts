import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Inside the WeldSuite monorepo the SDK is used from its TypeScript
  // sources; installed from npm it is plain JavaScript and this does nothing.
  transpilePackages: ['@weldsuite/commerce-sdk'],
  poweredByHeader: false,
  // Don't let `next dev` write an AGENTS.md into the app folder (the
  // WeldSuite repo keeps its own agent instructions). Remove in a fork if you want it.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Guest order links carry a token in the query string: never send it to other sites.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@weldsuite/ui", "@weldsuite/i18n", "@weldsuite/text"],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;

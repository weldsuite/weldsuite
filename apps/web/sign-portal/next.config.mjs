/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@weldsuite/ui"],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;

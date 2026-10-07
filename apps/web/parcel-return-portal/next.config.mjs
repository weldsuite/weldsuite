/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@weldsuite/ui", "@weldsuite/text"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
}

export default nextConfig
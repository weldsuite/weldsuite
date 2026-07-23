/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow images from any domain (user-uploaded logos)
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
};

export default nextConfig;

import type { MetadataRoute } from 'next';

export default async function robots({
  params,
}: {
  params: Promise<{ domain: string }>;
}): Promise<MetadataRoute.Robots> {
  const { domain } = await params;
  return {
    rules: {
      userAgent: '*',
      allow: '/',
    },
    sitemap: `https://${domain}/sitemap.xml`,
  };
}

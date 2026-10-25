export interface SitemapEntry {
  url: string;
  lastModified?: string | Date;
  changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Serializes sitemap entries to sitemaps.org XML. */
export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lastModified =
      entry.lastModified instanceof Date ? entry.lastModified.toISOString() : entry.lastModified;
    return [
      '<url>',
      `<loc>${escapeXml(entry.url)}</loc>`,
      lastModified ? `<lastmod>${lastModified}</lastmod>` : '',
      entry.changeFrequency ? `<changefreq>${entry.changeFrequency}</changefreq>` : '',
      entry.priority !== undefined ? `<priority>${entry.priority}</priority>` : '',
      '</url>',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

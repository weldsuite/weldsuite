import { useRouteLoaderData } from 'react-router';

import { config } from '../lib/client';
import type { RootData } from '../routes/root';

/**
 * The page's title, description and canonical URL. React 19 moves these
 * tags into <head> wherever they are rendered; the prerendered ones are
 * removed at start-up (main.tsx), so the two never disagree.
 */
export function PageMeta({ title, description, path }: Readonly<{ title?: string; description?: string | null; path?: string }>) {
  const root = useRouteLoaderData('root') as RootData | undefined;
  const shop = root?.channel.name ?? 'Shop';
  const canonical = path && config ? `${config.shopUrl}${path}` : null;
  return (
    <>
      <title>{title ? `${title} · ${shop}` : shop}</title>
      {description ? <meta name="description" content={description.slice(0, 300)} /> : null}
      {canonical ? <link rel="canonical" href={canonical} /> : null}
    </>
  );
}

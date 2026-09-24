import type { Metadata } from 'next';
import { getPortalConfig } from '@/lib/server/portal';

/** Tab title and favicon come from the workspace's branding, server-side, so they're right on first paint. */
export async function generateMetadata({ params }: { params: Promise<{ workspace: string }> }): Promise<Metadata> {
  const { workspace } = await params;
  const config = await getPortalConfig(workspace);
  if (!config) return {};
  return {
    title: config.displayName || 'Portal',
    description: config.welcomeMessage || undefined,
    icons: config.faviconUrl ? { icon: config.faviconUrl } : undefined,
    // Personal pages; nothing here should end up in a search index.
    robots: { index: false, follow: false },
  };
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}

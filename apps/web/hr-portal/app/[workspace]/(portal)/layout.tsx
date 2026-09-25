import { HydrationBoundary } from '@tanstack/react-query';
import { hydratePortalQueries } from '@/lib/server/portal';
import { PortalShell } from '@/components/portal-shell';

/**
 * Signed-in area. The session is checked on the server: `/me` is loaded here,
 * an expired session gets an HTTP redirect to the sign-in page, and the shell
 * renders with the user and branding already in the HTML.
 */
export default async function PortalLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}>) {
  const { workspace } = await params;
  const state = await hydratePortalQueries(workspace, [{ path: '/me' }]);
  return (
    <HydrationBoundary state={state}>
      <PortalShell>{children}</PortalShell>
    </HydrationBoundary>
  );
}

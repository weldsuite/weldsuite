import { HydrationBoundary } from '@tanstack/react-query';
import { getPortalConfig, hydratePortalConfig } from '@/lib/server/portal';
import { PortalNotAvailable } from '@/components/portal-not-available';
import LoginView from './view';

/** Server-rendered sign-in: branding is loaded on the server, so the page arrives on-brand. */
export default async function LoginPage({ params }: Readonly<{ params: Promise<{ workspace: string }> }>) {
  const { workspace } = await params;
  const config = await getPortalConfig(workspace);
  if (!config) return <PortalNotAvailable />;
  const state = await hydratePortalConfig(workspace, config);
  return (
    <HydrationBoundary state={state}>
      <LoginView />
    </HydrationBoundary>
  );
}

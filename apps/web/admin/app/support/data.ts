import '@tanstack/react-start/server-only';

import { listEnterpriseWorkspaces } from '@/lib/support-data';
import { requireAdmin } from '@/lib/auth';

/** Everything the support inbox page shows. */
export async function loadSupportPage() {
  await requireAdmin();
  const workspaces = await listEnterpriseWorkspaces();
  return {
    workspaces,
    // The realtime worker's public WebSocket origin, which the browser joins
    // support rooms on (per environment in wrangler.toml).
    realtimeUrl: process.env.REALTIME_PUBLIC_URL || 'ws://localhost:8790',
  };
}

export type SupportPageData = NonNullable<Awaited<ReturnType<typeof loadSupportPage>>>;

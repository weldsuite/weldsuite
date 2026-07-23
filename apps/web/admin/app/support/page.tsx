import { listEnterpriseWorkspaces } from '@/lib/support-data';
import { requireAdmin } from '@/lib/auth';
import { SupportInbox } from './support-inbox';

export const dynamic = 'force-dynamic';

export default async function SupportPage() {
  await requireAdmin();
  const workspaces = await listEnterpriseWorkspaces();
  return <SupportInbox workspaces={workspaces} />;
}

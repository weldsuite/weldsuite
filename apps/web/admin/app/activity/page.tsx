import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { ActivityTable } from '@/components/billing/activity-table';
import { requireAdmin } from '@/lib/auth';
import { listAuditEvents } from '@/lib/billing-data';
import { adminCopy } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  await requireAdmin();
  const events = await listAuditEvents({ limit: 300 });
  const t = adminCopy();

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading title={t.activity.title} description={t.activity.description} />
        <ActivityTable events={events} showTarget />
      </PageBody>
    </PageContent>
  );
}

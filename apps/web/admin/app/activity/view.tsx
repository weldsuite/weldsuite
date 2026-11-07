import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { ActivityTable } from '@/components/billing/activity-table';
import { adminCopy } from '@/lib/i18n';
import type { ActivityPageData } from './data';

export function ActivityPage({ events }: Readonly<ActivityPageData>) {
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

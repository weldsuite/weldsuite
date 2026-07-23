/**
 * `ActivityTab` — Activity tab for company / person object panels.
 *
 * Thin adapter over the legacy `ActivitySection` from `customer-detail/`,
 * which renders a grouped-by-day timeline of CRM activities (calls,
 * emails, meetings, notes, deal stage changes, etc.). The section itself
 * is presentational — we just need to fetch the activities for the
 * current entity and pass them in.
 *
 * `useActivities` already maps `customerId` (companies) and `contactId`
 * (persons) to the right wire param. The `customer` prop is only required
 * by the section's TypeScript signature — it doesn't dereference any
 * fields on it for rendering, so a `{ id }`-only shim is safe.
 */

import { useTranslations } from '@weldsuite/i18n/client';
import { useActivities } from '@/hooks/queries/use-activities-queries';
import { ActivitySection } from '@/components/customer-detail/sections/activity-section';
import type { Activity, Customer } from '@/components/customer-detail/types';

interface ActivityTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function ActivityTab({ entityId, entityKind }: ActivityTabProps) {
  const t = useTranslations();
  const filter = entityKind === 'company' ? { customerId: entityId } : { contactId: entityId };
  const { data, isLoading } = useActivities(filter);

  if (isLoading) {
    return (
      <div className="px-3 py-6 text-sm text-muted-foreground text-center">
        {t('sweep.entities.loadingActivity')}
      </div>
    );
  }

  const activities = (data?.data ?? []) as Activity[];
  const totalCount = data?.pagination?.totalCount ?? activities.length;

  return (
    <ActivitySection
      customer={{ id: entityId } as Customer}
      activities={activities}
      totalCount={totalCount}
    />
  );
}

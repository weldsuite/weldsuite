/** The Prospects tab: who is in the campaign, from which mailbox and how far along. */

import { useMemo, useState } from 'react';
import { UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  reachEnrollmentStatusSchema,
  type ReachCampaignDetail,
  type ReachEnrollment,
  type ReachEnrollmentStatus,
} from '@weldsuite/app-api-client/schemas/reach';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import {
  useReachEnrollments,
  useRemoveReachEnrollment,
} from '@/hooks/queries/use-reach-campaign-queries';
import {
  EnrollmentStatusBadge,
  enrollmentStatusKey,
} from '@/app/weldreach/components/engage/badges';
import { personName, useReachFormat } from '@/app/weldreach/components/engage/format';
import { selectFilterConfig, useSelectFilter } from '@/app/weldreach/components/engage/filters';
import { FilterSelect, emptyIcon, errorMessage } from '@/app/weldreach/components/engage/kit';
import { AddProspectsDialog } from './add-prospects-dialog';

const STATUS_OPTIONS = reachEnrollmentStatusSchema.options;

/** Why an enrollment stopped, for the reasons reach-api records; anything else is shown as stored. */
const STOPPED_REASON_KEYS: Record<string, string> = {
  reply: 'reachEngage.enrollments.stopped.reply',
  replied: 'reachEngage.enrollments.stopped.reply',
  company_replied: 'reachEngage.enrollments.stopped.company_replied',
  replied_company: 'reachEngage.enrollments.stopped.company_replied',
  replied_elsewhere: 'reachEngage.enrollments.stopped.replied_elsewhere',
  bounce: 'reachEngage.enrollments.stopped.bounce',
  bounced: 'reachEngage.enrollments.stopped.bounce',
  hard_bounce: 'reachEngage.enrollments.stopped.bounce',
  smtp_rejected: 'reachEngage.enrollments.stopped.bounce',
  unsubscribe: 'reachEngage.enrollments.stopped.unsubscribe',
  unsubscribed: 'reachEngage.enrollments.stopped.unsubscribe',
  suppressed: 'reachEngage.enrollments.stopped.suppressed',
  consumer: 'reachEngage.enrollments.stopped.consumer',
  consumer_domain: 'reachEngage.enrollments.stopped.consumer',
  missing_variable: 'reachEngage.enrollments.stopped.missing_variable',
  missing_variables: 'reachEngage.enrollments.stopped.missing_variable',
  auto_reply: 'reachEngage.enrollments.stopped.auto_reply',
  send_failed: 'reachEngage.enrollments.stopped.send_failed',
  prospect_deleted: 'reachEngage.enrollments.stopped.prospect_deleted',
  manual: 'reachEngage.enrollments.stopped.manual',
};

export function ProspectsTab({
  campaign,
  canEdit,
}: Readonly<{ campaign: ReachCampaignDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const statusFilter = useSelectFilter('status');
  const status = statusFilter.value as ReachEnrollmentStatus | undefined;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ReachEnrollment | null>(null);

  const query = useReachEnrollments(campaign.id, status);
  // "is not" has no server counterpart: it hides rows already loaded.
  const enrollments = useMemo(
    () => query.enrollments.filter((enrollment) => enrollment.status !== statusFilter.excluded),
    [query.enrollments, statusFilter.excluded],
  );
  const removeEnrollment = useRemoveReachEnrollment(campaign.id);
  const totalSteps = campaign.steps.length;

  function stoppedReason(reason: string | null): string {
    if (!reason) return '—';
    // reach-api records "suppressed:<why>"; the prefix is what the user needs to see.
    const key = STOPPED_REASON_KEYS[reason] ?? STOPPED_REASON_KEYS[reason.split(':')[0] ?? ''];
    return key ? t(key) : reason.replaceAll('_', ' ');
  }

  async function confirmRemove(enrollment: ReachEnrollment) {
    try {
      await removeEnrollment.mutateAsync(enrollment.id);
      toast.success(t('reachEngage.enrollments.removed'));
    } catch (err) {
      toast.error(errorMessage(err, t('reachEngage.enrollments.removeFailed')));
    } finally {
      setRemoving(null);
    }
  }

  const columns: ColumnDef<ReachEnrollment>[] = [
    {
      id: 'prospect',
      header: t('reachEngage.enrollments.table.prospect'),
      width: 'flex-1',
      render: (enrollment) => {
        const name = personName(enrollment.prospect);
        return (
          <span className="block min-w-0">
            <span className="block truncate text-sm font-medium">{name ?? enrollment.prospect.email}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {name ? enrollment.prospect.email : enrollment.prospect.companyName}
            </span>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: t('reachEngage.enrollments.table.status'),
      width: 'w-[120px]',
      render: (enrollment) => <EnrollmentStatusBadge status={enrollment.status} />,
    },
    {
      id: 'mailbox',
      header: t('reachEngage.enrollments.table.mailbox'),
      width: 'hidden lg:block lg:w-[220px]',
      render: (enrollment) =>
        enrollment.mailboxEmail ? (
          <span className="block truncate text-sm">{enrollment.mailboxEmail}</span>
        ) : (
          <span className="text-sm text-muted-foreground">{t('reachEngage.enrollments.mailboxPending')}</span>
        ),
    },
    {
      id: 'step',
      header: t('reachEngage.enrollments.table.stepsSent'),
      width: 'hidden md:block md:w-[100px]',
      render: (enrollment) => (
        <span className="text-sm tabular-nums">
          {format.number(Math.min(enrollment.currentStep, totalSteps))} / {format.number(totalSteps)}
        </span>
      ),
    },
    {
      id: 'next',
      header: t('reachEngage.enrollments.table.nextSend'),
      width: 'hidden md:block md:w-[160px]',
      render: (enrollment) => (
        <span className="text-sm text-muted-foreground">
          {enrollment.nextSendAt ? format.dateTime(enrollment.nextSendAt) : '—'}
        </span>
      ),
    },
    {
      id: 'stopped',
      header: t('reachEngage.enrollments.table.stoppedReason'),
      width: 'hidden xl:block xl:w-[160px]',
      render: (enrollment) => (
        <span className="block truncate text-sm text-muted-foreground">
          {stoppedReason(enrollment.stoppedReason)}
        </span>
      ),
    },
  ];

  const statusOptions = STATUS_OPTIONS.map((value) => ({ value, label: t(enrollmentStatusKey(value)) }));
  const isFiltered = status !== undefined || statusFilter.excluded !== undefined;

  return (
    <>
      <PanelEntityList<ReachEnrollment>
        items={enrollments}
        isLoading={query.isLoading}
        error={query.error}
        columns={columns}
        onDelete={canEdit ? (enrollment) => setRemoving(enrollment) : undefined}
        filters={[selectFilterConfig('status', t('reachEngage.enrollments.table.status'), statusOptions)]}
        activeFilters={statusFilter.filters}
        onFiltersChange={statusFilter.setFilters}
        // The filter pills are hidden on small screens, so a plain select stands in there.
        actionButtons={
          <FilterSelect
            value={status}
            onChange={statusFilter.setValue}
            options={statusOptions}
            allLabel={t('reachEngage.enrollments.allStatuses')}
            ariaLabel={t('reachEngage.enrollments.statusFilter')}
            className="md:hidden"
          />
        }
        createButton={
          canEdit
            ? {
                label: t('reachEngage.enrollments.addProspects'),
                onClick: () => setAdding(true),
              }
            : undefined
        }
        hasMore={query.hasNextPage}
        isLoadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        emptyState={{
          icon: emptyIcon(isFiltered ? Users : UserPlus),
          title: isFiltered
            ? t('reachEngage.enrollments.noResultsTitle')
            : t('reachEngage.enrollments.emptyTitle'),
          description: isFiltered
            ? t('reachEngage.enrollments.noResultsDescription')
            : t('reachEngage.enrollments.emptyDescription'),
          action:
            canEdit && !isFiltered
              ? { label: t('reachEngage.enrollments.addProspects'), onClick: () => setAdding(true) }
              : undefined,
        }}
        noResultsState={{
          title: t('reachEngage.enrollments.noResultsTitle'),
          description: t('reachEngage.enrollments.noResultsDescription'),
        }}
      />

      {adding && <AddProspectsDialog campaignId={campaign.id} onClose={() => setAdding(false)} />}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('reachEngage.enrollments.removeTitle')}
        description={t('reachEngage.enrollments.removeDescription', {
          prospect: removing ? (personName(removing.prospect) ?? removing.prospect.email) : '',
        })}
        confirmLabel={t('reachEngage.common.remove')}
        cancelLabel={t('reachEngage.common.cancel')}
        variant="destructive"
        onConfirm={() => (removing ? confirmRemove(removing) : undefined)}
      />
    </>
  );
}

/** Upcoming shifts card, shared by the Overview and Attendance tabs. */

import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import type { HrSelfOverview } from '@weldsuite/app-api-client/domains/weldhr';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { formatDateTime, formatTime } from '../../components/shared';

export function UpcomingShiftsCard({
  shifts,
  limit,
  title,
  emptyText,
  onViewAll,
}: Readonly<{
  shifts: HrSelfOverview['upcomingShifts'];
  /** Show only the first N shifts; omitted shows all of them. */
  limit?: number;
  /** Defaults to "Upcoming shifts". */
  title?: string;
  emptyText?: string;
  onViewAll?: () => void;
}>) {
  const t = useTranslations();
  const visible = limit === undefined ? shifts : shifts.slice(0, limit);

  return (
    <SectionCard
      title={title ?? t('weldhr.me.shifts.title')}
      action={
        onViewAll && (
          <Button variant="ghost" size="sm" onClick={onViewAll}>
            {t('weldhr.me.common.viewAll')}
          </Button>
        )
      }
    >
      {visible.length === 0 ? (
        <EmptyText>{emptyText ?? t('weldhr.me.shifts.empty')}</EmptyText>
      ) : (
        <ul className="space-y-2">
          {visible.map((shift) => (
            <li key={shift.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-sm">
              <span>
                {formatDateTime(shift.startsAt)} – {formatTime(shift.endsAt)}
              </span>
              {shift.companyName && <span className="text-muted-foreground">{shift.companyName}</span>}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/**
 * `RecordKindBadge` — the small "Company" / "Person" tag shown next to a CRM
 * record wherever companies and people are listed together (the Notes record
 * picker, the task dialog's record picker). One component so every picker
 * labels and colours the two kinds the same way.
 */

import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

export type RecordBadgeKind = 'company' | 'person';

interface RecordKindBadgeProps {
  kind: RecordBadgeKind;
  className?: string;
}

export function RecordKindBadge({ kind, className }: Readonly<RecordKindBadgeProps>) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none flex-shrink-0',
        kind === 'person'
          ? 'bg-purple-50 dark:bg-purple-950 text-purple-600 dark:text-purple-400'
          : 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400',
        className,
      )}
    >
      {kind === 'person' ? t('sweep.entities.personLabel') : t('sweep.entities.companyLabel')}
    </span>
  );
}

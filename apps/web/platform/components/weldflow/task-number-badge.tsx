'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { formatTaskNumber } from '@/lib/task-number';

interface TaskNumberBadgeProps {
  number: number | null | undefined;
  className?: string;
}

/**
 * Small monospace badge showing the human-friendly task number (TASK-<n>).
 * Click to copy the reference to the clipboard. Renders nothing when the task
 * has no number yet (pre-backfill rows).
 */
export function TaskNumberBadge({ number, className }: TaskNumberBadgeProps) {
  const t = useTranslations();
  const label = formatTaskNumber(number);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      if (!label) return;
      e.stopPropagation();
      e.preventDefault();
      navigator.clipboard
        ?.writeText(label)
        .then(() => toast.success(t('common.messages.copiedToClipboard')))
        .catch(() => {});
    },
    [label, t],
  );

  if (!label) return null;

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={t('common.actions.copyTaskNumber')}
      aria-label={t('common.actions.copyTaskNumber')}
      className={cn(
        'inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] leading-none text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:bg-secondary dark:text-muted-foreground dark:hover:bg-secondary/80',
        className,
      )}
    >
      {label}
    </button>
  );
}

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Clock } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DeskConversation, DeskSlaStatus } from '@/hooks/queries/use-desk-queries';

/**
 * The SLA chip for an inbox conversation, from the summary desk-api keeps on
 * the conversation (slaStatus / slaDueAt / slaMetric). The countdown runs on
 * the client; the sweep only has to update the row when a warning or breach
 * comes due.
 */

type Tone = 'ok' | 'warning' | 'breached' | 'muted';

export interface DeskSlaDisplay {
  label: string;
  title: string;
  tone: Tone;
}

/** Hex colors for the list's label chips, per tone. */
export const SLA_TONE_COLORS: Record<Tone, string> = {
  ok: '#0f766e',
  warning: '#d97706',
  breached: '#dc2626',
  muted: '#6b7280',
};

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  breached: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400',
  muted: 'bg-muted text-muted-foreground',
};

/** Tone of a clock that is still before its due time. */
const RUNNING_TONES: Partial<Record<DeskSlaStatus, Tone>> = { warning: 'warning', breached: 'breached' };

/** "45m", "3h 5m", "2d 4h". */
export function formatSlaDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** What to show for a conversation's SLA at `now`, or null when there is nothing to show. */
export function deskSlaDisplay(
  conversation: Pick<DeskConversation, 'state' | 'slaStatus' | 'slaDueAt' | 'slaMetric'>,
  now: number,
  options: { showPaused?: boolean; showFinished?: boolean } = {},
): DeskSlaDisplay | null {
  const t = getTranslations('deskInbox2').sla;
  const { slaStatus, slaDueAt, slaMetric } = conversation;
  if (!slaStatus) return null;

  if (slaDueAt && slaMetric && conversation.state === 'open') {
    const due = new Date(slaDueAt).getTime();
    const metric = t.metrics[slaMetric];
    const title = t.dueAtTitle.replace('{metric}', metric).replace('{date}', format(due, 'PPp'));
    const remaining = due - now;
    if (remaining <= 0) {
      return { label: t.overdue.replace('{metric}', metric).replace('{time}', formatSlaDuration(remaining)), title, tone: 'breached' };
    }
    return {
      label: t.dueIn.replace('{metric}', metric).replace('{time}', formatSlaDuration(remaining)),
      title,
      tone: RUNNING_TONES[slaStatus] ?? 'ok',
    };
  }
  if (slaStatus === 'paused' && options.showPaused) return { label: t.paused, title: t.pausedTitle, tone: 'muted' };
  if (slaStatus === 'breached') return { label: t.breached, title: t.breached, tone: 'breached' };
  if (slaStatus === 'achieved' && options.showFinished) return { label: t.achieved, title: t.achieved, tone: 'ok' };
  return null;
}

/** The current time, re-read every `intervalMs` so countdowns move without refetching. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function DeskSlaBadge({
  conversation,
  className,
}: Readonly<{ conversation: DeskConversation; className?: string }>) {
  const now = useNow();
  const display = deskSlaDisplay(conversation, now, { showPaused: true, showFinished: true });
  if (!display) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0',
        TONE_CLASSES[display.tone],
        className,
      )}
      title={display.title}
      data-testid="desk-inbox-sla-badge"
      data-sla-tone={display.tone}
    >
      <Clock className="h-3 w-3" />
      {display.label}
    </span>
  );
}

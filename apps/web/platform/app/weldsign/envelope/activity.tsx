/**
 * A request's activity, oldest first: who was sent it, opened it, signed,
 * declined, was reminded, and so on. It is the evidence trail, so owners only
 * (the server answers anyone else with a 404).
 */

import {
  Ban,
  Bell,
  CheckCheck,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FilePlus,
  KeyRound,
  Mail,
  Pencil,
  PenLine,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { SignEventDto, SignEventType } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useSignEnvelopeEvents } from '@/hooks/queries/use-weldsign-queries';
import { describeEvent, type ActivityLine } from '../lib/activity';
import { useDateTime } from '../lib/use-date-time';

const EVENT_ICON: Record<SignEventType, { icon: LucideIcon; className: string }> = {
  created: { icon: FilePlus, className: 'text-muted-foreground' },
  sent: { icon: Send, className: 'text-sky-600' },
  delivered: { icon: Mail, className: 'text-emerald-600' },
  opened: { icon: Eye, className: 'text-amber-600' },
  code_sent: { icon: KeyRound, className: 'text-muted-foreground' },
  code_verified: { icon: ShieldCheck, className: 'text-emerald-600' },
  code_failed: { icon: ShieldAlert, className: 'text-destructive' },
  consented: { icon: PenLine, className: 'text-muted-foreground' },
  signed: { icon: CheckCircle2, className: 'text-emerald-600' },
  declined: { icon: XCircle, className: 'text-destructive' },
  reminded: { icon: Bell, className: 'text-amber-600' },
  resent: { icon: RefreshCw, className: 'text-sky-600' },
  recipient_corrected: { icon: Pencil, className: 'text-muted-foreground' },
  voided: { icon: Ban, className: 'text-destructive' },
  expired: { icon: Clock, className: 'text-muted-foreground' },
  completed: { icon: CheckCheck, className: 'text-emerald-600' },
  downloaded: { icon: Download, className: 'text-muted-foreground' },
};

export function ActivityTimeline({ envelopeId, enabled }: Readonly<{ envelopeId: string; enabled: boolean }>) {
  const { t } = useI18n();
  const ta = t.weldsign.overview.activity;
  const events = useSignEnvelopeEvents(envelopeId, enabled);
  if (!enabled) return null;

  return (
    <section className="flex flex-col gap-2" aria-label={ta.title}>
      <h2 className="text-sm font-medium">{ta.title}</h2>
      <ActivityBody
        events={events.data}
        isLoading={events.isLoading}
        isError={events.isError}
        onRetry={() => void events.refetch()}
      />
    </section>
  );
}

function ActivityBody({
  events,
  isLoading,
  isError,
  onRetry,
}: Readonly<{ events: SignEventDto[] | undefined; isLoading: boolean; isError: boolean; onRetry: () => void }>) {
  const { t, format } = useI18n();
  const ta = t.weldsign.overview.activity;

  if (isLoading) return <p className="text-sm text-muted-foreground">{ta.loading}</p>;
  if (isError || !events) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>{ta.failed}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {ta.retry}
        </Button>
      </div>
    );
  }

  // Types this client does not know yet are skipped.
  const rows = events.flatMap((event) => {
    const line = describeEvent(event, ta, format);
    return line ? [{ event, line }] : [];
  });
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{ta.empty}</p>;

  return (
    <ol className="rounded-lg border p-4">
      {rows.map(({ event, line }, i) => (
        <ActivityRow key={event.id} event={event} line={line} last={i === rows.length - 1} />
      ))}
    </ol>
  );
}

function ActivityRow({ event, line, last }: Readonly<{ event: SignEventDto; line: ActivityLine; last: boolean }>) {
  const dateTime = useDateTime('medium');
  const { icon: Icon, className } = EVENT_ICON[event.type];
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background">
          <Icon className={cn('size-3.5', className)} />
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn('min-w-0 flex-1', !last && 'pb-4')}>
        <p className="text-sm">{line.text}</p>
        {line.reason && <p className="break-words text-sm text-muted-foreground">{line.reason}</p>}
        <p className="text-xs text-muted-foreground">
          <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
          {line.by && <span> · {line.by}</span>}
          {event.ip && <span className="tabular-nums"> · {event.ip}</span>}
        </p>
      </div>
    </li>
  );
}

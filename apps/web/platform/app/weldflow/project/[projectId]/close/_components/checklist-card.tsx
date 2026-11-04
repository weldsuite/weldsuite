import { Check, Clock } from 'lucide-react';
import type { CloseCheck } from '@weldsuite/app-api-client/domains/project-closing';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { formatShortDate } from '@/app/weldflow/project/[projectId]/raid/_lib/raid';
import { checkDetail } from '../_lib/close';
import { useClose } from './close-context';
import { RaidItems } from './raid-items';

function StateIcon({ check }: Readonly<{ check: CloseCheck }>) {
  if (check.done) {
    return (
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (check.state === 'waiting') {
    return (
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-muted-foreground/50 text-muted-foreground">
        <Clock className="size-3" />
      </span>
    );
  }
  return <span aria-hidden className="size-5 shrink-0 rounded-full border-2 border-orange-500" />;
}

function Deliverables() {
  const { t, language } = useI18n();
  const copy = t.flowClosing.close.checklist;
  const { checklist } = useClose();
  const locale = intlLocaleOf(language);
  const accepted = checklist.deliverables.filter((d) => d.status === 'accepted');
  const other = checklist.deliverables.filter((d) => d.status !== 'accepted');
  const statusText = copy.deliverableStatus as Record<string, string>;
  if (checklist.deliverables.length === 0) return null;
  return (
    <div className="mt-2 ml-8 flex flex-col gap-1.5">
      {accepted.length > 0 ? (
        <ul aria-label={copy.acceptedDeliverables} className="flex flex-wrap gap-1.5">
          {accepted.map((d) => (
            <li key={d.id} title={d.title} className="rounded-md bg-muted px-2 py-0.5 text-xs text-foreground/80">
              <strong className="font-semibold text-foreground">{d.code}</strong> {formatShortDate(d.acceptedAt, locale)}
            </li>
          ))}
        </ul>
      ) : null}
      {other.length > 0 ? (
        <ul aria-label={copy.otherDeliverables} className="flex flex-wrap gap-1.5">
          {other.map((d) => (
            <li key={d.id} title={d.title} className="rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
              <strong className="font-semibold text-foreground/80">{d.code}</strong> {statusText[d.status] ?? d.status}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function checkStateTone(check: CloseCheck): string {
  if (check.done) return 'text-green-700 dark:text-green-400';
  if (check.state === 'waiting') return 'text-muted-foreground';
  return 'text-orange-700 dark:text-orange-400';
}

function CheckRow({ check }: Readonly<{ check: CloseCheck }>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowClosing.close.checklist;
  const { checklist, memberOf } = useClose();
  const sponsor = memberOf(checklist.signOff.sponsorId)?.name ?? null;
  const detail = checkDetail(check, { copy: t.flowClosing.close, plural, format, signOff: checklist.signOff, sponsorName: sponsor });
  const stateTone = checkStateTone(check);
  return (
    <li className={cn('border-b px-4 py-3 last:border-b-0', !check.done && check.state === 'open' && 'bg-orange-50/40 dark:bg-orange-950/10')}>
      <div className="flex items-center gap-2.5">
        <StateIcon check={check} />
        <span className="text-[13px] font-semibold">{copy.checks[check.key].title}</span>
        <span className={cn('ml-auto text-xs font-medium whitespace-nowrap', stateTone)}>{copy.state[check.state]}</span>
      </div>
      <div className="mt-1 ml-8 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>{detail}</span>
        {check.blocking && !check.done ? <span className="text-[11px] italic">· {copy.blocking}</span> : null}
      </div>
      {check.key === 'deliverables' ? <Deliverables /> : null}
      {check.key === 'raid' && checklist.raidItems.length > 0 ? <RaidItems items={checklist.raidItems} /> : null}
    </li>
  );
}

/** The close checklist, one row per check in the API's order. */
export function ChecklistCard() {
  const { t } = useI18n();
  const { checklist } = useClose();
  return (
    <section aria-labelledby="close-checklist-title" className="overflow-hidden rounded-xl border bg-card">
      <h3 id="close-checklist-title" className="border-b px-4 py-3.5 text-sm font-semibold">
        {t.flowClosing.close.checklist.title}
      </h3>
      <ol>
        {checklist.checks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </ol>
    </section>
  );
}

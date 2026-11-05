import type { IntakeFunnel, ProjectRequest, ProjectRequestStatus } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '../../capacity/_lib/capacity';
import { STATUS_CLASS, formatMoney, needsText } from '../_lib/intake';

const FUNNEL: Array<{ status: Exclude<ProjectRequestStatus, 'converted'>; dot: string }> = [
  { status: 'new', dot: 'bg-neutral-400' },
  { status: 'assessing', dot: 'bg-blue-600' },
  { status: 'approved', dot: 'bg-green-600' },
  { status: 'rejected', dot: 'bg-neutral-700' },
];

/** Requests per stage, with a short note under each. */
export function FunnelStrip({ funnel }: Readonly<{ funnel: IntakeFunnel }>) {
  const { t, format } = useI18n();
  const copy = t.flowPortfolio.intake.funnel;
  const note = (status: string): string => {
    if (status === 'new') return format(copy.newNote, { count: funnel.newLast7Days });
    if (status === 'assessing') return funnel.oldestAssessingDays === null ? copy.none : format(copy.assessingNote, { days: funnel.oldestAssessingDays });
    if (status === 'approved') return copy.approvedNote;
    return '';
  };
  return (
    <ol aria-label={copy.label} className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
      {FUNNEL.map(({ status, dot }) => (
        <li key={status} className="rounded-lg border bg-card px-4 py-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn('size-2 rounded-full', dot)} />
            {copy[status]}
          </div>
          <div className="mt-1 text-2xl font-semibold">{funnel.counts[status]}</div>
          <div className="mt-0.5 min-h-4 text-xs text-foreground/70">{note(status)}</div>
        </li>
      ))}
    </ol>
  );
}

interface TableProps {
  requests: ProjectRequest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  showRejected: boolean;
  onShowRejected: (value: boolean) => void;
  nameOf: (id: string) => string;
}

/** The ranked table: rank by score, status, cost and value, what the request needs, and the score as a bar. */
export function RequestTable({ requests, selectedId, onSelect, showRejected, onShowRejected, nameOf }: Readonly<TableProps>) {
  const { t, format, language } = useI18n();
  const copy = t.flowPortfolio.intake.table;
  const locale = intlLocaleOf(language);
  return (
    <section aria-labelledby="req-title" className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h2 id="req-title" className="flex-1 text-[15px] font-semibold">
          {copy.title}
        </h2>
        <label className="inline-flex items-center gap-1.5 text-[13px]">
          <Checkbox checked={showRejected} onCheckedChange={(value) => onShowRejected(value === true)} />
          {copy.showRejected}
        </label>
      </div>
      {requests.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="w-7 py-2.5 pr-2 pl-4 font-medium">
                  {copy.rank}
                </th>
                <th scope="col" className="px-2 py-2.5 font-medium">
                  {copy.request}
                </th>
                <th scope="col" className="px-2 py-2.5 font-medium">
                  {copy.status}
                </th>
                <th scope="col" className="px-2 py-2.5 text-right font-medium">
                  {copy.cost}
                </th>
                <th scope="col" className="px-2 py-2.5 text-right font-medium">
                  {copy.value}
                </th>
                <th scope="col" className="px-2 py-2.5 font-medium">
                  {copy.needs}
                </th>
                <th scope="col" className="w-36 py-2.5 pr-4 pl-2 font-medium">
                  {copy.score}
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request, index) => (
                <tr key={request.id} className={cn('border-t', request.id === selectedId && 'bg-muted/40')}>
                  <td className="py-3 pr-2 pl-4 font-semibold text-muted-foreground">{index + 1}</td>
                  <td className="px-2 py-3">
                    <button type="button" aria-current={request.id === selectedId} onClick={() => onSelect(request.id)} className="text-left font-semibold hover:underline">
                      {request.title}
                    </button>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {request.code} · {format(copy.by, { name: nameOf(request.requestedBy) })}
                    </div>
                  </td>
                  <td className="px-2 py-3 whitespace-nowrap">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_CLASS[request.status])}>
                      {t.flowPortfolio.intake.status[request.status]}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-right whitespace-nowrap tabular-nums">{formatMoney(request.estimatedCost, locale)}</td>
                  <td className="px-2 py-3 text-right whitespace-nowrap tabular-nums">{formatMoney(request.estimatedValue, locale)}</td>
                  <td className="px-2 py-3 text-xs text-foreground/80">{needsText(request.neededSkills) || '–'}</td>
                  <td className="py-3 pr-4 pl-2">
                    {request.score === null ? (
                      <span className="text-xs text-muted-foreground">{copy.unscored}</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-2 bg-primary" style={{ width: `${request.score}%` }} />
                        </div>
                        <span className="min-w-6 text-right font-bold tabular-nums">{Math.round(request.score)}</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">{copy.footnote}</p>
    </section>
  );
}

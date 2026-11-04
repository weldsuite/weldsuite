import { useEffect, useMemo, useState } from 'react';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import {
  useCreateStatusReport,
  useDeleteStatusReport,
  usePublishStatusReport,
  useRefreshStatusReport,
  useStatusReport,
  useStatusReportSettings,
  useStatusReports,
  usePutStatusReportSettings,
  useUpdateStatusReport,
} from '@/hooks/queries/use-project-reporting-queries';
import type {
  StatusColour,
  StatusReport,
  StatusReportArea,
  StatusReportSettings,
  StatusReportSummary,
} from '@weldsuite/app-api-client/domains/project-reporting';

const DOT: Record<StatusColour, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-600',
  grey: 'bg-muted-foreground/40',
};
const PILL: Record<StatusColour, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  red: 'bg-red-500/10 text-red-700 dark:text-red-300',
  grey: 'bg-muted text-muted-foreground',
};
type RagColour = Exclude<StatusColour, 'grey'>;

const BTN = 'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50';
const PRIMARY = 'inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50';
const CARD = 'rounded-lg border bg-card p-4';

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] === undefined || values[key] === null ? '-' : String(values[key])));
}

function Pill({ colour, label }: Readonly<{ colour: StatusColour; label: string }>) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${PILL[colour]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[colour]}`} />
      {label}
    </span>
  );
}

function Tag({ label, tone }: Readonly<{ label: string; tone: 'auto' | 'written' }>) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${tone === 'auto' ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'bg-violet-500/10 text-violet-700 dark:text-violet-300'}`}>
      {label}
    </span>
  );
}

function useCopy() {
  const { t } = useI18n();
  return t.flowReporting;
}

function dateText(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '-';
}

/** Governance > Status reports: the report list, the editor and the schedule. */
export default function StatusReportsPage() {
  const copy = useCopy();
  const params = useParams();
  const projectId = params.projectId as string;
  const { canWrite, isAdmin } = useProjectPermissions();
  const reports = useStatusReports(projectId);
  const create = useCreateStatusReport();
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => reports.data ?? [], [reports.data]);

  useEffect(() => {
    if (reports.isFetching) return;
    if (!selected || !rows.some((row) => row.id === selected)) setSelected(rows[0]?.id ?? null);
  }, [rows, selected, reports.isFetching]);

  const manage = canWrite && isAdmin;

  return (
    <div className="flex flex-wrap items-start gap-4">
      <aside className="w-full max-w-[280px] flex-1 basis-60 rounded-lg border bg-card">
        <div className="flex items-center gap-2 border-b p-3">
          <h2 className="flex-1 text-sm font-semibold">{copy.list.title}</h2>
          {manage ? (
            <button type="button" className={BTN} disabled={create.isPending} onClick={() => create.mutate({ projectId }, { onSuccess: (report) => setSelected(report.id) })}>
              {copy.list.new}
            </button>
          ) : null}
        </div>
        {reports.isLoading ? <p className="p-4 text-sm text-muted-foreground">...</p> : null}
        {reports.isError ? <p className="p-4 text-sm text-destructive">{copy.report.failed}</p> : null}
        {!reports.isLoading && rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{copy.list.empty}</p> : null}
        <ul className="p-1.5">
          {rows.map((row) => (
            <ReportRow key={row.id} row={row} active={row.id === selected} onSelect={() => setSelected(row.id)} />
          ))}
        </ul>
        <ScheduleCard projectId={projectId} manage={manage} />
      </aside>
      <div className="min-w-0 flex-[999_1_640px]">
        {selected ? <ReportEditor key={selected} id={selected} manage={manage} onGone={() => setSelected(null)} onOpen={setSelected} /> : null}
      </div>
    </div>
  );
}

function ReportRow({ row, active, onSelect }: Readonly<{ row: StatusReportSummary; active: boolean; onSelect: () => void }>) {
  const copy = useCopy();
  return (
    <li>
      <button type="button" onClick={onSelect} aria-current={active ? 'page' : undefined} className={`flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-muted ${active ? 'bg-muted' : ''}`}>
        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[row.overall ?? 'grey']}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{row.period}</span>
          <span className="block text-xs text-muted-foreground">
            {row.status === 'published' ? `${copy.status.published} ${dateText(row.publishedAt)}` : copy.status.draft}
            {row.supersededById ? ` · ${copy.list.superseded}` : ''}
          </span>
        </span>
      </button>
    </li>
  );
}

// -- Schedule -------------------------------------------------------------------

type RecipientRule = 'sponsor' | 'all_stakeholders' | 'portal_contacts';

function scheduleSummary(copy: ReturnType<typeof useCopy>, schedule: StatusReportSettings | null, nextDraftAt: string | null | undefined): string {
  let text: string = copy.schedule.off;
  if (schedule) {
    text = fill(copy.schedule.summary, { cadence: copy.schedule.cadences[schedule.cadence], weekday: copy.schedule.weekdays[schedule.weekday - 1], hour: schedule.hour });
  }
  if (nextDraftAt) text += ` · ${fill(copy.schedule.nextDraft, { date: dateText(nextDraftAt) })}`;
  return text;
}

function CadenceFields({
  showWeekday,
  showRecipients,
  weekday,
  onWeekday,
  hour,
  onHour,
  rule,
  onRule,
}: Readonly<{
  showWeekday: boolean;
  showRecipients: boolean;
  weekday: number;
  onWeekday: (value: number) => void;
  hour: number;
  onHour: (value: number) => void;
  rule: RecipientRule;
  onRule: (value: RecipientRule) => void;
}>) {
  const copy = useCopy();
  return (
    <>
      {showWeekday ? (
        <label className="flex flex-col gap-1 text-xs">
          {copy.schedule.weekday}
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={weekday} onChange={(event) => onWeekday(Number(event.target.value))}>
            {copy.schedule.weekdays.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-xs">
        {copy.schedule.hour}
        <input type="number" min={0} max={23} className="h-8 rounded-md border bg-background px-2 text-sm" value={hour} onChange={(event) => onHour(Math.min(23, Math.max(0, Number(event.target.value) || 0)))} />
      </label>
      {showRecipients ? (
        <label className="flex flex-col gap-1 text-xs">
          {copy.schedule.recipients}
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={rule} onChange={(event) => onRule(event.target.value as RecipientRule)}>
            {(['sponsor', 'all_stakeholders', 'portal_contacts'] as const).map((value) => (
              <option key={value} value={value}>
                {copy.schedule.rules[value]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}

function ScheduleCard({ projectId, manage }: Readonly<{ projectId: string; manage: boolean }>) {
  const copy = useCopy();
  const settings = useStatusReportSettings(projectId);
  const save = usePutStatusReportSettings();
  const [open, setOpen] = useState(false);
  const current = settings.data;
  const schedule = current?.statusReport ?? null;
  const [cadence, setCadence] = useState<StatusReportSettings['cadence'] | 'manual'>('weekly');
  const [weekday, setWeekday] = useState(1);
  const [hour, setHour] = useState(9);
  const [rule, setRule] = useState<RecipientRule>('sponsor');
  const [appetite, setAppetite] = useState(9);

  useEffect(() => {
    if (!current) return;
    setCadence(schedule?.cadence ?? 'manual');
    setWeekday(schedule?.weekday ?? 1);
    setHour(schedule?.hour ?? 9);
    setRule(schedule?.recipients.rule ?? 'sponsor');
    setAppetite(current.riskAppetite);
  }, [current, schedule]);

  const submit = () => {
    const statusReport: StatusReportSettings | null =
      cadence === 'manual' ? null : { cadence, weekday, hour, recipients: schedule?.recipients.stakeholderIds ? { stakeholderIds: schedule.recipients.stakeholderIds } : { rule } };
    save.mutate({ projectId, input: { statusReport, riskAppetite: appetite } }, { onSuccess: () => setOpen(false) });
  };

  return (
    <div className="border-t p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">{copy.schedule.title}</span>
        {manage ? (
          <button type="button" className="text-xs text-primary" onClick={() => setOpen(!open)}>
            {open ? copy.report.cancel : copy.report.override}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{scheduleSummary(copy, schedule, current?.nextDraftAt)}</p>
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs">
            {copy.schedule.cadence}
            <select className="h-8 rounded-md border bg-background px-2 text-sm" value={cadence} onChange={(event) => setCadence(event.target.value as typeof cadence)}>
              {(['weekly', 'biweekly', 'monthly', 'manual'] as const).map((value) => (
                <option key={value} value={value}>
                  {copy.schedule.cadences[value]}
                </option>
              ))}
            </select>
          </label>
          {cadence !== 'manual' ? (
            <CadenceFields
              showWeekday={cadence !== 'monthly'}
              showRecipients={!schedule?.recipients.stakeholderIds}
              weekday={weekday}
              onWeekday={setWeekday}
              hour={hour}
              onHour={setHour}
              rule={rule}
              onRule={setRule}
            />
          ) : null}
          <label className="flex flex-col gap-1 text-xs">
            {copy.schedule.appetite}
            <input type="number" min={1} max={25} className="h-8 rounded-md border bg-background px-2 text-sm" value={appetite} onChange={(event) => setAppetite(Math.min(25, Math.max(1, Number(event.target.value) || 1)))} />
          </label>
          <button type="button" className={PRIMARY} disabled={save.isPending} onClick={submit}>
            {copy.report.save}
          </button>
          {save.isError ? <p className="text-xs text-destructive">{copy.report.failed}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// -- Editor ---------------------------------------------------------------------

function ReportActions({
  id,
  report,
  manage,
  editable,
  preview,
  onTogglePreview,
  onGone,
  onOpen,
  onError,
}: Readonly<{
  id: string;
  report: StatusReport;
  manage: boolean;
  editable: boolean;
  preview: boolean;
  onTogglePreview: () => void;
  onGone: () => void;
  onOpen: (id: string) => void;
  onError: () => void;
}>) {
  const copy = useCopy();
  const refresh = useRefreshStatusReport();
  const publish = usePublishStatusReport();
  const discard = useDeleteStatusReport();
  const create = useCreateStatusReport();
  const draft = report.status === 'draft';
  return (
    <>
      {editable ? (
        <button type="button" className={BTN} disabled={refresh.isPending} onClick={() => refresh.mutate(id, { onError })}>
          {copy.report.refresh}
        </button>
      ) : null}
      <button type="button" className={BTN} onClick={onTogglePreview}>
        {preview ? copy.report.exitPreview : copy.report.preview}
      </button>
      {draft && manage && !preview ? (
        <>
          <button type="button" className={BTN} onClick={() => window.confirm(copy.report.discardConfirm) && discard.mutate(id, { onSuccess: onGone, onError })}>
            {copy.report.discard}
          </button>
          <button
            type="button"
            className={PRIMARY}
            disabled={publish.isPending || !report.summary}
            title={report.summary ? undefined : copy.report.summaryRequired}
            onClick={() => window.confirm(copy.report.publishConfirm) && publish.mutate(id, { onError })}
          >
            {fill(copy.report.publishTo, { count: report.resolvedRecipients.length })}
          </button>
        </>
      ) : null}
      {!draft && manage ? (
        <button type="button" className={BTN} disabled={create.isPending} onClick={() => create.mutate({ projectId: report.projectId, period: report.period }, { onSuccess: (next) => onOpen(next.id), onError })}>
          {copy.report.correct}
        </button>
      ) : null}
    </>
  );
}

function ReportEditor({ id, manage, onGone, onOpen }: Readonly<{ id: string; manage: boolean; onGone: () => void; onOpen: (id: string) => void }>) {
  const copy = useCopy();
  const query = useStatusReport(id);
  const update = useUpdateStatusReport();
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState(false);
  const report = query.data;

  if (query.isLoading) return <p className="text-sm text-muted-foreground">...</p>;
  if (!report) return <p className="text-sm text-destructive">{copy.report.failed}</p>;

  const draft = report.status === 'draft';
  const editable = draft && manage && !preview;
  const fail = () => setError(true);
  const patch = (input: Parameters<typeof update.mutate>[0]['input']) => update.mutate({ id, input }, { onError: fail, onSuccess: () => setError(false) });

  return (
    <div className="flex flex-col gap-4">
      <section className={`${CARD} flex flex-col gap-3`}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 basis-72">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">{report.period}</h2>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{copy.status[report.status]}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {report.snapshot ? fill(copy.report.asOf, { date: new Date(report.snapshot.asOf).toLocaleString() }) : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReportActions
              id={id}
              report={report}
              manage={manage}
              editable={editable}
              preview={preview}
              onTogglePreview={() => setPreview(!preview)}
              onGone={onGone}
              onOpen={onOpen}
              onError={fail}
            />
          </div>
        </div>
        {!draft ? <p className="text-sm text-muted-foreground">{fill(copy.report.frozen, { date: dateText(report.publishedAt) })}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{copy.report.failed}</p> : null}
      </section>

      <OverallAndAreas report={report} editable={editable} onPatch={patch} />

      <section className={`${CARD} flex flex-col gap-2`}>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{copy.report.summary}</h3>
          <Tag label={copy.report.written} tone="written" />
        </div>
        <SummaryField key={report.updatedAt} value={report.summary ?? ''} editable={editable} onSave={(summary) => patch({ summary })} />
        {editable ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={report.clientVisible} onChange={(event) => patch({ clientVisible: event.target.checked })} />
            {copy.report.clientVisible}
          </label>
        ) : null}
      </section>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
        <ItemList title={copy.report.done} items={report.done} editable={editable} onChange={(done) => patch({ done })} />
        <ItemList title={copy.report.next} items={report.next} editable={editable} onChange={(next) => patch({ next })} />
        <TopRisks report={report} />
        <DecisionsAndChanges report={report} />
      </div>

      <Milestones report={report} />

      <p className="text-sm text-muted-foreground">
        {copy.report.recipients}:{' '}
        {report.resolvedRecipients.length === 0 ? copy.report.recipientsNone : report.resolvedRecipients.map((recipient) => recipient.name ?? '?').join(', ')}
      </p>
    </div>
  );
}

function SummaryField({ value, editable, onSave }: Readonly<{ value: string; editable: boolean; onSave: (value: string) => void }>) {
  const copy = useCopy();
  const [text, setText] = useState(value);
  if (!editable) return <p className="whitespace-pre-wrap text-sm">{value || '-'}</p>;
  return (
    <>
      <label htmlFor="report-summary" className="text-xs text-muted-foreground">
        {copy.report.summaryHint}
      </label>
      <textarea id="report-summary" rows={4} className="w-full rounded-md border bg-background p-2 text-sm" value={text} onChange={(event) => setText(event.target.value)} onBlur={() => text !== value && onSave(text)} />
    </>
  );
}

function OverallAndAreas({ report, editable, onPatch }: Readonly<{ report: StatusReport; editable: boolean; onPatch: (input: { overall?: RagColour; areas?: Array<{ key: StatusReportArea['key']; override: { colour: RagColour; reason: string } | null }> }) => void }>) {
  const copy = useCopy();
  const suggested = report.snapshot?.computed.overall ?? 'grey';
  return (
    <section className={`${CARD} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">{copy.report.overall}</h3>
        {editable ? (
          <div role="group" aria-label={copy.report.overall} className="inline-flex rounded-md bg-muted p-0.5">
            {(['green', 'amber', 'red'] as const).map((colour) => (
              <button key={colour} type="button" aria-pressed={report.overall === colour} onClick={() => onPatch({ overall: colour })} className={`rounded px-3 py-1 text-xs ${report.overall === colour ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'}`}>
                {copy.colours[colour]}
              </button>
            ))}
          </div>
        ) : (
          <Pill colour={report.overall ?? 'grey'} label={copy.colours[report.overall ?? 'grey']} />
        )}
        {editable ? <span className="text-xs text-muted-foreground">{fill(copy.report.overallHint, { colour: copy.colours[suggested] })}</span> : null}
      </div>
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        {report.areas.map((area) => (
          <AreaCard key={area.key} area={area} editable={editable} onPatch={onPatch} />
        ))}
      </div>
    </section>
  );
}

function reasonOf(copy: ReturnType<typeof useCopy>, area: StatusReportArea): string {
  if (!area.auto) return area.reason ?? '';
  const code = area.computed?.code;
  const template = code ? (copy.reasons as Record<string, string>)[code] : undefined;
  return template ? fill(template, area.computed?.params ?? {}) : copy.reasons.unknown;
}

function AreaCard({ area, editable, onPatch }: Readonly<{ area: StatusReportArea; editable: boolean; onPatch: (input: { areas: Array<{ key: StatusReportArea['key']; override: { colour: RagColour; reason: string } | null }> }) => void }>) {
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const [colour, setColour] = useState<RagColour>(area.colour === 'grey' ? 'amber' : area.colour);
  const [reason, setReason] = useState(area.reason ?? '');
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold">{copy.areas[area.key]}</span>
        <Pill colour={area.colour} label={copy.colours[area.colour]} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{reasonOf(copy, area)}</p>
      <div className="flex items-center gap-2">
        <Tag label={area.auto ? copy.report.filledIn : copy.report.overridden} tone={area.auto ? 'auto' : 'written'} />
        {!area.auto && area.computed ? <span className="text-[11px] text-muted-foreground">{fill(copy.report.computedWas, { colour: copy.colours[area.computed.colour] })}</span> : null}
        {editable ? (
          <button type="button" className="ml-auto text-xs text-primary" onClick={() => setOpen(!open)}>
            {copy.report.override}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-2 border-t pt-2">
          <select aria-label={copy.areas[area.key]} className="h-8 rounded-md border bg-background px-2 text-sm" value={colour} onChange={(event) => setColour(event.target.value as typeof colour)}>
            {(['green', 'amber', 'red'] as const).map((value) => (
              <option key={value} value={value}>
                {copy.colours[value]}
              </option>
            ))}
          </select>
          <textarea aria-label={copy.report.reasonLabel} rows={2} placeholder={copy.report.reasonPlaceholder} className="rounded-md border bg-background p-2 text-sm" value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} disabled={!reason.trim()} onClick={() => { onPatch({ areas: [{ key: area.key, override: { colour, reason } }] }); setOpen(false); }}>
              {copy.report.save}
            </button>
            {!area.auto ? (
              <button type="button" className={BTN} onClick={() => { onPatch({ areas: [{ key: area.key, override: null }] }); setOpen(false); }}>
                {copy.report.resetOverride}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ItemList({ title, items, editable, onChange }: Readonly<{ title: string; items: StatusReport['done']; editable: boolean; onChange: (items: Array<{ taskId?: string | null; text: string; code?: string | null; date?: string | null }>) => void }>) {
  const copy = useCopy();
  const [text, setText] = useState('');
  return (
    <section className={`${CARD} flex flex-col gap-2`}>
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        <Tag label={copy.report.filledIn} tone="auto" />
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {items.map((item, index) => (
          <li key={`${item.code ?? 'own'}-${index}`} className="flex items-start gap-2">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{item.code ?? ''}</span>
            <span className="min-w-0 flex-1">{item.text}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{dateText(item.date)}</span>
            {editable ? (
              <button type="button" aria-label={copy.stakeholders.plan.remove} className="text-xs text-muted-foreground hover:text-destructive" onClick={() => onChange(items.filter((_, at) => at !== index))}>
                x
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (text.trim()) { onChange([...items, { text: text.trim() }]); setText(''); } }}>
          <input className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" placeholder={copy.report.addLine} value={text} onChange={(event) => setText(event.target.value)} />
          <button type="submit" className={BTN}>+</button>
        </form>
      ) : null}
    </section>
  );
}

function TopRisks({ report }: Readonly<{ report: StatusReport }>) {
  const copy = useCopy();
  const risks = report.snapshot?.topRisks ?? [];
  return (
    <section className={`${CARD} flex flex-col gap-2`}>
      <h3 className="text-sm font-semibold">{copy.report.topRisks}</h3>
      <ul className="flex flex-col gap-2 text-sm">
        {risks.map((risk) => (
          <li key={risk.id} className="flex items-center gap-2">
            <span className="w-8 rounded bg-muted py-0.5 text-center text-xs font-bold">{risk.score}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted-foreground">{risk.code}</span>
              {risk.title}
            </span>
            {risk.previousScore !== null && risk.previousScore !== risk.score ? <span className="text-xs text-muted-foreground">{fill(copy.report.previously, { score: risk.previousScore })}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionsAndChanges({ report }: Readonly<{ report: StatusReport }>) {
  const copy = useCopy();
  const rows = [
    ...(report.snapshot?.decisions ?? []).map((row) => ({ id: row.id, code: row.code, title: row.title, meta: dateText(row.dueAt) })),
    ...(report.snapshot?.changes ?? []).map((row) => ({ id: row.id, code: row.code, title: row.title, meta: row.status })),
  ];
  return (
    <section className={`${CARD} flex flex-col gap-2`}>
      <h3 className="text-sm font-semibold">{copy.report.decisionsAndChanges}</h3>
      <ul className="flex flex-col gap-2 text-sm">
        {rows.map((row) => (
          <li key={row.id} className="flex gap-2">
            <span className="w-14 shrink-0 text-xs text-muted-foreground">{row.code}</span>
            <span className="min-w-0 flex-1">{row.title}</span>
            <span className="text-xs text-muted-foreground">{row.meta}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function varianceText(copy: ReturnType<typeof useCopy>, days: number | null): string {
  if (days === null) return '-';
  return days > 0 ? fill(copy.report.days, { days: '+' + days }) : copy.report.onTime;
}

function Milestones({ report }: Readonly<{ report: StatusReport }>) {
  const copy = useCopy();
  const rows = report.snapshot?.milestones ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <h3 className="border-b p-3 text-sm font-semibold">{fill(copy.report.milestones, { version: report.snapshot?.baselineVersion ?? '-' })}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="p-3 font-medium">{copy.report.milestoneName}</th>
              <th className="p-3 font-medium">{copy.report.baseline}</th>
              <th className="p-3 font-medium">{copy.report.forecast}</th>
              <th className="p-3 font-medium">{copy.report.variance}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.kind}-${row.id ?? 'go'}`} className="border-t">
                <td className="p-3">{row.kind === 'go_live' ? copy.report.goLive : row.name}</td>
                <td className="p-3 text-muted-foreground">{dateText(row.baselineDate)}</td>
                <td className="p-3">{dateText(row.forecastDate)}</td>
                <td className={`p-3 font-semibold ${(row.varianceDays ?? 0) > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                  {varianceText(copy, row.varianceDays)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

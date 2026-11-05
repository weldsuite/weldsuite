import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { SubNavToolbar } from '@/app/weldflow/components/sub-nav';
import { LIST_ROW_CLASS, LIST_ROW_SELECTED_CLASS, ListCode, ListPill, ListRowTarget } from '@/app/weldflow/components/list-cells';
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
/** RAG colours on the pill shape of a list row. */
const PILL: Record<StatusColour, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  red: 'bg-red-500/10 text-red-700 dark:text-red-300',
  grey: 'bg-muted text-muted-foreground',
};
type RagColour = Exclude<StatusColour, 'grey'>;

/** An outline toolbar button, as RAID's "Show closed". */
const OUTLINE = 'h-8 px-3 text-sm shadow-none';
/** A flush section of the report: padded, ruled off from the next one. */
const SECTION = 'border-b border-border px-4 py-5';
/** A section heading. */
const HEADING = 'text-sm font-semibold';
/** Cells of a ruled grid (1px gaps drawn as lines), as the RAID matrix. */
const GRID_LINES = 'grid gap-px border-b border-border bg-border';

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] === undefined || values[key] === null ? '-' : String(values[key])));
}

function Rag({ colour, label }: Readonly<{ colour: StatusColour; label: string }>) {
  return (
    <ListPill className={PILL[colour]}>
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', DOT[colour])} />
      {label}
    </ListPill>
  );
}

function Tag({ label, tone }: Readonly<{ label: string; tone: 'auto' | 'written' }>) {
  return (
    <ListPill className={tone === 'auto' ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'bg-violet-500/10 text-violet-700 dark:text-violet-300'}>
      {label}
    </ListPill>
  );
}

function useCopy() {
  const { t } = useI18n();
  return t.flowReporting;
}

function dateText(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '-';
}

/**
 * Governance › Status reports: the reports in a column flush with the borders
 * (as the RAID matrix column), the open report beside it in flush sections,
 * and "New report" in the shared toolbar.
 */
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
  const createReport = () => create.mutate({ projectId }, { onSuccess: (report) => setSelected(report.id) });

  return (
    <>
      <SubNavToolbar createButton={manage ? { label: copy.list.new, onClick: createReport } : undefined} />
      {/* The column sits beside the report when the page is wide enough (measured on the page, so an open panel counts). */}
      <div className="@container/reports flex flex-1 flex-col">
        <div className="flex flex-1 flex-col @4xl/reports:flex-row">
          <aside className="flex shrink-0 flex-col border-b border-border @4xl/reports:w-[18rem] @4xl/reports:border-r @4xl/reports:border-b-0">
            <div className="flex h-[35px] items-center border-b border-border/70 px-4 text-xs font-medium text-muted-foreground">{copy.list.title}</div>
            {reports.isLoading ? <p className="px-4 py-3 text-sm text-muted-foreground">…</p> : null}
            {reports.isError ? <p className="px-4 py-3 text-sm text-destructive">{copy.report.failed}</p> : null}
            {rows.map((row) => (
              <ReportRow key={row.id} row={row} active={row.id === selected} onSelect={() => setSelected(row.id)} />
            ))}
            <Schedule projectId={projectId} manage={manage} />
          </aside>
          <main className="min-w-0 flex-1">
            {selected ? <ReportEditor key={selected} id={selected} manage={manage} onGone={() => setSelected(null)} onOpen={setSelected} /> : null}
            {!reports.isLoading && rows.length === 0 ? (
              <div className="flex min-h-[calc(100dvh-350px)] flex-col items-center justify-center px-6 text-center">
                <EmptyStateIllustration>
                  <FileText className="h-12 w-12 text-gray-300 dark:text-muted-foreground" />
                </EmptyStateIllustration>
                <h3 className="mb-1.5 text-[15px] font-semibold text-foreground">{copy.list.empty}</h3>
                {manage ? (
                  <Button size="sm" className="mt-4 h-8" onClick={createReport} disabled={create.isPending}>
                    <Plus className="h-4 w-4" />
                    {copy.list.new}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </main>
        </div>
      </div>
    </>
  );
}

/** A report in the column: a standard row with its RAG dot, period and status. */
function ReportRow({ row, active, onSelect }: Readonly<{ row: StatusReportSummary; active: boolean; onSelect: () => void }>) {
  const copy = useCopy();
  const status = row.status === 'published' ? `${copy.status.published} ${dateText(row.publishedAt)}` : copy.status.draft;
  return (
    <div aria-current={active ? 'page' : undefined} className={cn(LIST_ROW_CLASS, active && LIST_ROW_SELECTED_CLASS)}>
      <ListRowTarget label={row.period} onClick={onSelect} />
      <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rounded-full', DOT[row.overall ?? 'grey'])} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-foreground">{row.period}</span>
      <span className="shrink-0 truncate text-sm text-gray-600 dark:text-muted-foreground">
        {status}
        {row.supersededById ? ` · ${copy.list.superseded}` : ''}
      </span>
    </div>
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

/** A labelled field of the schedule form. */
function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A select of the schedule form, on the library Select. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{ label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void }>) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger aria-label={label} className="h-8 w-full shadow-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function Schedule({ projectId, manage }: Readonly<{ projectId: string; manage: boolean }>) {
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
    <section className="border-t border-border px-4 py-3 text-sm @4xl/reports:mt-auto">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">{copy.schedule.title}</span>
        {manage ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen(!open)}>
            {open ? copy.report.cancel : copy.report.override}
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{scheduleSummary(copy, schedule, current?.nextDraftAt)}</p>
      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          <Choice
            label={copy.schedule.cadence}
            value={cadence}
            onChange={setCadence}
            options={(['weekly', 'biweekly', 'monthly', 'manual'] as const).map((value) => ({ value, label: copy.schedule.cadences[value] }))}
          />
          {cadence !== 'manual' && cadence !== 'monthly' ? (
            <Choice
              label={copy.schedule.weekday}
              value={String(weekday)}
              onChange={(value) => setWeekday(Number(value))}
              options={copy.schedule.weekdays.map((name, index) => ({ value: String(index + 1), label: name }))}
            />
          ) : null}
          {cadence !== 'manual' ? (
            <Field label={copy.schedule.hour}>
              <Input type="number" min={0} max={23} className="h-8 shadow-none" value={hour} onChange={(event) => setHour(Math.min(23, Math.max(0, Number(event.target.value) || 0)))} />
            </Field>
          ) : null}
          {cadence !== 'manual' && !schedule?.recipients.stakeholderIds ? (
            <Choice
              label={copy.schedule.recipients}
              value={rule}
              onChange={setRule}
              options={(['sponsor', 'all_stakeholders', 'portal_contacts'] as const).map((value) => ({ value, label: copy.schedule.rules[value] }))}
            />
          ) : null}
          <Field label={copy.schedule.appetite}>
            <Input type="number" min={1} max={25} className="h-8 shadow-none" value={appetite} onChange={(event) => setAppetite(Math.min(25, Math.max(1, Number(event.target.value) || 1)))} />
          </Field>
          <Button type="button" size="sm" className="h-8" disabled={save.isPending} onClick={submit}>
            {copy.report.save}
          </Button>
          {save.isError ? <p className="text-xs text-destructive">{copy.report.failed}</p> : null}
        </div>
      ) : null}
    </section>
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
  const { t } = useI18n();
  const refresh = useRefreshStatusReport();
  const publish = usePublishStatusReport();
  const discard = useDeleteStatusReport();
  const create = useCreateStatusReport();
  const [confirming, setConfirming] = useState<'discard' | 'publish' | null>(null);
  const draft = report.status === 'draft';
  const publishLabel = fill(copy.report.publishTo, { count: report.resolvedRecipients.length });
  return (
    <>
      {editable ? (
        <Button type="button" variant="outline" size="sm" className={OUTLINE} disabled={refresh.isPending} onClick={() => refresh.mutate(id, { onError })}>
          {copy.report.refresh}
        </Button>
      ) : null}
      <Button type="button" variant="outline" size="sm" className={OUTLINE} onClick={onTogglePreview}>
        {preview ? copy.report.exitPreview : copy.report.preview}
      </Button>
      {draft && manage && !preview ? (
        <>
          <Button type="button" variant="outline" size="sm" className={OUTLINE} onClick={() => setConfirming('discard')}>
            {copy.report.discard}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={publish.isPending || !report.summary}
            title={report.summary ? undefined : copy.report.summaryRequired}
            onClick={() => setConfirming('publish')}
          >
            {publishLabel}
          </Button>
        </>
      ) : null}
      {!draft && manage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={OUTLINE}
          disabled={create.isPending}
          onClick={() => create.mutate({ projectId: report.projectId, period: report.period }, { onSuccess: (next) => onOpen(next.id), onError })}
        >
          {copy.report.correct}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(isOpen) => (isOpen ? undefined : setConfirming(null))}
        title={confirming === 'discard' ? copy.report.discard : publishLabel}
        description={confirming === 'discard' ? copy.report.discardConfirm : copy.report.publishConfirm}
        confirmLabel={confirming === 'discard' ? copy.report.discard : publishLabel}
        cancelLabel={t.common.actions.cancel}
        variant={confirming === 'discard' ? 'destructive' : 'default'}
        loading={discard.isPending || publish.isPending}
        onConfirm={() => {
          if (confirming === 'discard') discard.mutate(id, { onSuccess: onGone, onError, onSettled: () => setConfirming(null) });
          else publish.mutate(id, { onError, onSettled: () => setConfirming(null) });
        }}
      />
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

  if (query.isLoading) return <p className="px-4 py-5 text-sm text-muted-foreground">…</p>;
  if (!report) return <p className="px-4 py-5 text-sm text-destructive">{copy.report.failed}</p>;

  const draft = report.status === 'draft';
  const editable = draft && manage && !preview;
  const fail = () => setError(true);
  const patch = (input: Parameters<typeof update.mutate>[0]['input']) => update.mutate({ id, input }, { onError: fail, onSuccess: () => setError(false) });

  return (
    <div className="flex flex-col">
      {/* The report's header row: the standard toolbar row, as a list's top bar and the analytics report header. */}
      <div className="flex h-[53px] shrink-0 items-center justify-between gap-4 border-b border-border px-3 pt-2 pb-2 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="shrink-0 text-sm font-medium">{report.period}</h2>
          <ListPill className="shrink-0 bg-muted text-foreground/80">{copy.status[report.status]}</ListPill>
          <p className="hidden truncate text-sm text-muted-foreground md:block">
            {draft
              ? report.snapshot
                ? fill(copy.report.asOf, { date: new Date(report.snapshot.asOf).toLocaleString() })
                : ''
              : fill(copy.report.frozen, { date: dateText(report.publishedAt) })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
      {error ? (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive">
          {copy.report.failed}
        </p>
      ) : null}

      <OverallAndAreas report={report} editable={editable} onPatch={patch} />

      <section className={cn(SECTION, 'flex flex-col gap-2')}>
        <div className="flex items-center gap-2">
          <h3 className={HEADING}>{copy.report.summary}</h3>
          <Tag label={copy.report.written} tone="written" />
        </div>
        <SummaryField key={report.updatedAt} value={report.summary ?? ''} editable={editable} onSave={(summary) => patch({ summary })} />
        {editable ? (
          <label className="mt-1 flex items-center gap-2 text-sm">
            <Checkbox checked={report.clientVisible} onCheckedChange={(checked) => patch({ clientVisible: checked === true })} />
            {copy.report.clientVisible}
          </label>
        ) : null}
      </section>

      {/* Four flush columns ruled off from each other, stacking on a narrow page. */}
      <div className={cn(GRID_LINES, '@container/lists')}>
        <div className="grid gap-px @3xl/lists:grid-cols-2 @6xl/lists:grid-cols-4">
          <ItemList title={copy.report.done} items={report.done} editable={editable} onChange={(done) => patch({ done })} />
          <ItemList title={copy.report.next} items={report.next} editable={editable} onChange={(next) => patch({ next })} />
          <TopRisks report={report} />
          <DecisionsAndChanges report={report} />
        </div>
      </div>

      <Milestones report={report} />

      <p className="px-4 py-5 text-sm text-muted-foreground">
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
      <Textarea id="report-summary" rows={4} className="shadow-none" value={text} onChange={(event) => setText(event.target.value)} onBlur={() => text !== value && onSave(text)} />
    </>
  );
}

type AreasPatch = { overall?: RagColour; areas?: Array<{ key: StatusReportArea['key']; override: { colour: RagColour; reason: string } | null }> };

function OverallAndAreas({ report, editable, onPatch }: Readonly<{ report: StatusReport; editable: boolean; onPatch: (input: AreasPatch) => void }>) {
  const copy = useCopy();
  const suggested = report.snapshot?.computed.overall ?? 'grey';
  return (
    <>
      <section className={cn(SECTION, 'flex flex-wrap items-center gap-3')}>
        <h3 className={HEADING}>{copy.report.overall}</h3>
        {editable ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={report.overall ?? ''}
            onValueChange={(colour) => {
              if (colour) onPatch({ overall: colour as RagColour });
            }}
            aria-label={copy.report.overall}
            className="shadow-none"
          >
            {(['green', 'amber', 'red'] as const).map((colour) => (
              <ToggleGroupItem
                key={colour}
                value={colour}
                className="h-8 flex-none gap-1.5 px-3 font-normal text-muted-foreground dark:bg-input/30 data-[state=on]:font-medium dark:data-[state=on]:bg-input/50"
              >
                <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', DOT[colour])} />
                {copy.colours[colour]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <Rag colour={report.overall ?? 'grey'} label={copy.colours[report.overall ?? 'grey']} />
        )}
        {editable ? <span className="text-xs text-muted-foreground">{fill(copy.report.overallHint, { colour: copy.colours[suggested] })}</span> : null}
      </section>
      {/* The five areas as one ruled row of cells, wrapping on a narrow page. */}
      <div className={cn(GRID_LINES, '[grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]')}>
        {report.areas.map((area) => (
          <AreaCell key={area.key} area={area} editable={editable} onPatch={onPatch} />
        ))}
      </div>
    </>
  );
}

function reasonOf(copy: ReturnType<typeof useCopy>, area: StatusReportArea): string {
  if (!area.auto) return area.reason ?? '';
  const code = area.computed?.code;
  const template = code ? (copy.reasons as Record<string, string>)[code] : undefined;
  return template ? fill(template, area.computed?.params ?? {}) : copy.reasons.unknown;
}

function AreaCell({ area, editable, onPatch }: Readonly<{ area: StatusReportArea; editable: boolean; onPatch: (input: AreasPatch) => void }>) {
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const [colour, setColour] = useState<RagColour>(area.colour === 'grey' ? 'amber' : area.colour);
  const [reason, setReason] = useState(area.reason ?? '');
  return (
    <div className="flex flex-col gap-2 bg-background p-4">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold">{copy.areas[area.key]}</span>
        <Rag colour={area.colour} label={copy.colours[area.colour]} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{reasonOf(copy, area)}</p>
      <div className="mt-auto flex items-center gap-2">
        <Tag label={area.auto ? copy.report.filledIn : copy.report.overridden} tone={area.auto ? 'auto' : 'written'} />
        {!area.auto && area.computed ? <span className="text-[11px] text-muted-foreground">{fill(copy.report.computedWas, { colour: copy.colours[area.computed.colour] })}</span> : null}
        {editable ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen(!open)}>
            {copy.report.override}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <Select value={colour} onValueChange={(value) => setColour(value as RagColour)}>
            <SelectTrigger aria-label={copy.areas[area.key]} className="h-8 w-full shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['green', 'amber', 'red'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {copy.colours[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea aria-label={copy.report.reasonLabel} rows={2} placeholder={copy.report.reasonPlaceholder} className="shadow-none" value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={!reason.trim()}
              onClick={() => {
                onPatch({ areas: [{ key: area.key, override: { colour, reason } }] });
                setOpen(false);
              }}
            >
              {copy.report.save}
            </Button>
            {!area.auto ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={OUTLINE}
                onClick={() => {
                  onPatch({ areas: [{ key: area.key, override: null }] });
                  setOpen(false);
                }}
              >
                {copy.report.resetOverride}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One column of the four: a heading and its lines, on the page background. */
function Column({ title, tag, children }: Readonly<{ title: string; tag?: ReactNode; children: ReactNode }>) {
  return (
    <section className="flex min-w-0 flex-col gap-3 bg-background p-4">
      <div className="flex items-center gap-2">
        <h3 className={cn(HEADING, 'flex-1')}>{title}</h3>
        {tag}
      </div>
      {children}
    </section>
  );
}

/** A line of a column: the code chip, the text and a muted detail on the right. */
function Line({ code, text, meta, action }: Readonly<{ code?: string | null; text: string; meta?: string; action?: ReactNode }>) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {code ? <ListCode code={code} /> : null}
      <span className="min-w-0 flex-1">{text}</span>
      {meta ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span> : null}
      {action}
    </li>
  );
}

function ItemList({ title, items, editable, onChange }: Readonly<{ title: string; items: StatusReport['done']; editable: boolean; onChange: (items: Array<{ taskId?: string | null; text: string; code?: string | null; date?: string | null }>) => void }>) {
  const copy = useCopy();
  const [text, setText] = useState('');
  return (
    <Column title={title} tag={<Tag label={copy.report.filledIn} tone="auto" />}>
      <ul className="flex flex-col gap-2">
        {items.map((item, index) => (
          <Line
            key={`${item.code ?? 'own'}-${index}`}
            code={item.code}
            text={item.text}
            meta={dateText(item.date)}
            action={
              editable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={copy.stakeholders.plan.remove}
                  className="h-5 w-5 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onChange(items.filter((_, at) => at !== index))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              ) : null
            }
          />
        ))}
      </ul>
      {editable ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) {
              onChange([...items, { text: text.trim() }]);
              setText('');
            }
          }}
        >
          <Input className="h-8 min-w-0 flex-1 shadow-none" placeholder={copy.report.addLine} value={text} onChange={(event) => setText(event.target.value)} />
          <Button type="submit" variant="outline" size="sm" className="h-8 w-8 p-0 shadow-none" aria-label={copy.report.addLine}>
            <Plus className="h-4 w-4" />
          </Button>
        </form>
      ) : null}
    </Column>
  );
}

function TopRisks({ report }: Readonly<{ report: StatusReport }>) {
  const copy = useCopy();
  const risks = report.snapshot?.topRisks ?? [];
  return (
    <Column title={copy.report.topRisks}>
      <ul className="flex flex-col gap-2">
        {risks.map((risk) => (
          <Line
            key={risk.id}
            code={risk.code}
            text={risk.title}
            meta={risk.previousScore !== null && risk.previousScore !== risk.score ? `${risk.score} · ${fill(copy.report.previously, { score: risk.previousScore })}` : String(risk.score)}
          />
        ))}
      </ul>
    </Column>
  );
}

function DecisionsAndChanges({ report }: Readonly<{ report: StatusReport }>) {
  const copy = useCopy();
  const { t } = useI18n();
  const changeStatus = t.flowApprovals.changes.status as Record<string, string>;
  const rows = [
    ...(report.snapshot?.decisions ?? []).map((row) => ({ id: row.id, code: row.code, title: row.title, meta: dateText(row.dueAt) })),
    ...(report.snapshot?.changes ?? []).map((row) => ({ id: row.id, code: row.code, title: row.title, meta: changeStatus[row.status] ?? row.status })),
  ];
  return (
    <Column title={copy.report.decisionsAndChanges}>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <Line key={row.id} code={row.code} text={row.title} meta={row.meta} />
        ))}
      </ul>
    </Column>
  );
}

function varianceText(copy: ReturnType<typeof useCopy>, days: number | null): string {
  if (days === null) return '-';
  return days > 0 ? fill(copy.report.days, { days: '+' + days }) : copy.report.onTime;
}

/** Milestones against the baseline, as a list: its header row and task-style rows. */
function Milestones({ report }: Readonly<{ report: StatusReport }>) {
  const copy = useCopy();
  const rows = report.snapshot?.milestones ?? [];
  if (rows.length === 0) return null;
  const columns = 'grid grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_7.5rem] items-center gap-4 px-4';
  return (
    <section className="border-b border-border">
      <h3 className={cn(HEADING, 'px-4 pt-5 pb-3')}>{fill(copy.report.milestones, { version: report.snapshot?.baselineVersion ?? '-' })}</h3>
      <div className={cn(columns, 'h-[35px] border-y border-border/70 text-xs font-medium text-muted-foreground')}>
        <span>{copy.report.milestoneName}</span>
        <span>{copy.report.baseline}</span>
        <span>{copy.report.forecast}</span>
        <span>{copy.report.variance}</span>
      </div>
      {rows.map((row) => (
        <div key={`${row.kind}-${row.id ?? 'go'}`} className={cn(columns, 'border-b border-gray-200/70 py-3 text-sm last:border-b-0 dark:border-border')}>
          <span className="truncate font-medium text-gray-900 dark:text-foreground">{row.kind === 'go_live' ? copy.report.goLive : row.name}</span>
          <span className="tabular-nums text-gray-600 dark:text-muted-foreground">{dateText(row.baselineDate)}</span>
          <span className="tabular-nums">{dateText(row.forecastDate)}</span>
          <span className={cn('font-medium tabular-nums', (row.varianceDays ?? 0) > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300')}>
            {varianceText(copy, row.varianceDays)}
          </span>
        </div>
      ))}
    </section>
  );
}

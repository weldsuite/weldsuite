import { useEffect, useState } from 'react';
import { Loader2, MoreHorizontal, Plus, UsersRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_FILTER_OPERATORS, type PanelFilterOperator } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelCohortDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateWeldPanelCohort,
  useDeleteWeldPanelCohort,
  useUpdateWeldPanelCohort,
  useWeldPanelCohorts,
} from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ClampedNumberInput } from '../components/clamped-number-input';
import { FilterBuilder } from '../components/filter-builder';
import { LabeledField } from '../components/labeled-field';
import { EventPicker, PropertyPicker } from '../components/pickers';
import {
  cohortFilterFromDraft,
  draftFromCohortFilter,
  emptyCohortDraft,
  emptyCondition,
  summariseCohortFilter,
  type CohortDraft,
  type ConditionDraft,
} from '../lib/cohort-draft';
import { operatorNeedsValue } from '../lib/filters';
import { formatDate } from '../lib/format';

interface CohortEditorProps {
  projectId: string;
  /** The cohort being edited; null creates one. */
  cohort: PanelCohortDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CohortEditor({ projectId, cohort, open, onOpenChange }: Readonly<CohortEditorProps>) {
  const { t } = useI18n();
  const tc = t.weldpanel.analytics.cohorts;
  const tcm = t.weldpanel.analytics.common;
  const tf = t.weldpanel.analytics.filters;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<CohortDraft>(emptyCohortDraft);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateWeldPanelCohort();
  const update = useUpdateWeldPanelCohort(cohort?.id ?? '');
  const busy = create.isPending || update.isPending;

  // Every opening starts from the cohort being edited, or a blank one.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(cohort?.name ?? '');
    setDescription(cohort?.description ?? '');
    setDraft((cohort && draftFromCohortFilter(cohort.filter)) || emptyCohortDraft());
  }, [open, cohort]);

  const updateCondition = (index: number, patch: Partial<ConditionDraft>) =>
    setDraft((d) => ({ ...d, conditions: d.conditions.map((c, i) => (i === index ? ({ ...c, ...patch } as ConditionDraft) : c)) }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === '') return setError(tc.nameRequired);
    const filter = cohortFilterFromDraft(draft);
    if (!filter) return setError(tc.incomplete);
    setError(null);
    const body = { name: name.trim(), description: description.trim() === '' ? null : description.trim(), filter };
    try {
      if (cohort) await update.mutateAsync(body);
      else await create.mutateAsync({ projectId, ...body });
      toast.success(tc.saved);
      onOpenChange(false);
    } catch {
      toast.error(tc.saveFailed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{cohort ? tc.editTitle : tc.createTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} noValidate className="grid gap-5">
          <LabeledField label={tcm.name} htmlFor="weldpanel-cohort-name">
            <Input id="weldpanel-cohort-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={tc.namePlaceholder} maxLength={255} autoComplete="off" />
          </LabeledField>
          <LabeledField label={`${tcm.description} (${tcm.optional})`} htmlFor="weldpanel-cohort-description">
            <Textarea id="weldpanel-cohort-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={2000} />
          </LabeledField>

          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="weldpanel-cohort-match">{tc.match}</Label>
              <Select value={draft.match} onValueChange={(match) => setDraft((d) => ({ ...d, match: match as 'all' | 'any' }))}>
                <SelectTrigger id="weldpanel-cohort-match" size="sm" className="h-8 w-auto min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tc.matchAll}</SelectItem>
                  <SelectItem value="any">{tc.matchAny}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <ol className="grid gap-3" aria-label={tc.conditions}>
              {draft.conditions.map((condition, index) => {
                const n = index + 1;
                return (
                  <li key={index} className="grid gap-3 rounded-lg border p-3">
                    <div className="flex items-end gap-2">
                      <LabeledField label={tc.conditionTypes[condition.type]} htmlFor={`weldpanel-cohort-type-${index}`} className="w-52">
                        <Select
                          value={condition.type}
                          onValueChange={(type) => setDraft((d) => ({ ...d, conditions: d.conditions.map((c, i) => (i === index ? emptyCondition(type as ConditionDraft['type']) : c)) }))}
                        >
                          <SelectTrigger id={`weldpanel-cohort-type-${index}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="person_property">{tc.conditionTypes.person_property}</SelectItem>
                            <SelectItem value="performed">{tc.conditionTypes.performed}</SelectItem>
                          </SelectContent>
                        </Select>
                      </LabeledField>
                      {draft.conditions.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="ml-auto size-8"
                          aria-label={tc.removeCondition.replace('{n}', String(n))}
                          onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, i) => i !== index) }))}
                        >
                          <X />
                        </Button>
                      )}
                    </div>

                    {condition.type === 'person_property' ? (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <LabeledField label={tc.property} htmlFor={`weldpanel-cohort-key-${index}`}>
                          <PropertyPicker id={`weldpanel-cohort-key-${index}`} projectId={projectId} value={condition.key} onChange={(key) => updateCondition(index, { key })} ariaLabel={`${tc.property} ${n}`} />
                        </LabeledField>
                        <LabeledField label={tc.operator} htmlFor={`weldpanel-cohort-operator-${index}`}>
                          <Select value={condition.operator} onValueChange={(operator) => updateCondition(index, { operator: operator as PanelFilterOperator })}>
                            <SelectTrigger id={`weldpanel-cohort-operator-${index}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PANEL_FILTER_OPERATORS.map((operator) => (
                                <SelectItem key={operator} value={operator}>
                                  {tf.operators[operator]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </LabeledField>
                        {operatorNeedsValue(condition.operator) && (
                          <LabeledField label={tc.value} htmlFor={`weldpanel-cohort-value-${index}`}>
                            <Input
                              id={`weldpanel-cohort-value-${index}`}
                              value={condition.text}
                              onChange={(event) => updateCondition(index, { text: event.target.value })}
                              placeholder={condition.operator === 'in' ? tf.valuesPlaceholder : tf.valuePlaceholder}
                              autoComplete="off"
                            />
                          </LabeledField>
                        )}
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <LabeledField label={tc.event} htmlFor={`weldpanel-cohort-event-${index}`}>
                            <EventPicker id={`weldpanel-cohort-event-${index}`} projectId={projectId} value={condition.event} onChange={(event) => updateCondition(index, { event })} ariaLabel={`${tc.event} ${n}`} />
                          </LabeledField>
                          <LabeledField label={tc.performed} htmlFor={`weldpanel-cohort-negate-${index}`}>
                            <Select value={condition.negate ? 'not' : 'did'} onValueChange={(next) => updateCondition(index, { negate: next === 'not' })}>
                              <SelectTrigger id={`weldpanel-cohort-negate-${index}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="did">{tc.didIt}</SelectItem>
                                <SelectItem value="not">{tc.didNot}</SelectItem>
                              </SelectContent>
                            </Select>
                          </LabeledField>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          {!condition.negate && (
                            <>
                              <Label htmlFor={`weldpanel-cohort-count-${index}`}>{tc.atLeast}</Label>
                              <ClampedNumberInput
                                id={`weldpanel-cohort-count-${index}`}
                                className="w-24"
                                min={1}
                                max={100000}
                                value={condition.minCount}
                                onCommit={(minCount) => updateCondition(index, { minCount })}
                              />
                              <span>{tc.times}</span>
                            </>
                          )}
                          <Label htmlFor={`weldpanel-cohort-days-${index}`}>{tc.withinDays}</Label>
                          <ClampedNumberInput
                            id={`weldpanel-cohort-days-${index}`}
                            className="w-24"
                            min={1}
                            max={762}
                            value={condition.withinDays}
                            onCommit={(withinDays) => updateCondition(index, { withinDays })}
                          />
                          <span>{tc.days}</span>
                        </div>
                        <div className="grid gap-1">
                          <p className="text-xs text-muted-foreground">{tc.eventFilters}</p>
                          <FilterBuilder compact allowCohort={false} projectId={projectId} filters={condition.filters} onChange={(filters) => updateCondition(index, { filters })} />
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {draft.conditions.length < 10 && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setDraft((d) => ({ ...d, conditions: [...d.conditions, emptyCondition('person_property')] }))}>
                  <Plus />
                  {tc.addCondition}
                </Button>
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              {tcm.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {tcm.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CohortsList({ projectId, onEdit, onCreate }: Readonly<{ projectId: string; onEdit: (cohort: PanelCohortDto) => void; onCreate: () => void }>) {
  const { t, language } = useI18n();
  const tc = t.weldpanel.analytics.cohorts;
  const tcm = t.weldpanel.analytics.common;
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const { data: cohorts, isLoading, isError, refetch } = useWeldPanelCohorts(projectId);
  const [deleting, setDeleting] = useState<PanelCohortDto | null>(null);
  const remove = useDeleteWeldPanelCohort();

  if (isError) return <ErrorState message={tc.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  if (isLoading) return <Skeleton className="h-40 w-full" />;

  if (!cohorts || cohorts.length === 0) {
    return (
      <EmptyState
        icon={UsersRound}
        title={tc.emptyTitle}
        description={tc.emptyDescription}
        action={
          canCreate ? (
            <Button size="sm" onClick={onCreate}>
              <Plus />
              {tc.newCohort}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc.columns.name}</TableHead>
              <TableHead className="hidden md:table-cell">{tc.columns.rule}</TableHead>
              <TableHead className="hidden sm:table-cell">{tc.columns.updated}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {cohorts.map((cohort) => (
              <TableRow key={cohort.id}>
                <TableCell className="max-w-64">
                  <p className="truncate font-medium">{cohort.name}</p>
                  {cohort.description && <p className="truncate text-xs text-muted-foreground">{cohort.description}</p>}
                </TableCell>
                <TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">{summariseCohortFilter(cohort.filter, tc.summary, t.weldpanel.analytics.filters)}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{formatDate(cohort.updatedAt, language)}</TableCell>
                <TableCell>
                  {(canUpdate || canDelete) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t.weldpanel.analytics.reports.actions.replace('{name}', cohort.name)}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canUpdate && <DropdownMenuItem onSelect={() => onEdit(cohort)}>{tcm.edit}</DropdownMenuItem>}
                        {canUpdate && canDelete && <DropdownMenuSeparator />}
                        {canDelete && (
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(cohort)}>
                            {tcm.delete}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tc.deleteTitle.replace('{name}', deleting?.name ?? '')}
        description={tc.deleteDescription}
        confirmLabel={tcm.delete}
        cancelLabel={tcm.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(tc.deleted);
            setDeleting(null);
          } catch {
            toast.error(tc.deleteFailed);
          }
        }}
      />
    </>
  );
}

export default function CohortsPage() {
  const { t } = useI18n();
  const tc = t.weldpanel.analytics.cohorts;
  const canCreate = useCan('panel_reports:create');
  const [editor, setEditor] = useState<{ cohort: PanelCohortDto | null } | null>(null);
  return (
    <AnalyticsPage
      title={tc.title}
      description={tc.description}
      actions={
        canCreate ? (
          <Button size="sm" onClick={() => setEditor({ cohort: null })}>
            <Plus />
            {tc.newCohort}
          </Button>
        ) : undefined
      }
    >
      {(project) => (
        <>
          <CohortsList key={project.id} projectId={project.id} onEdit={(cohort) => setEditor({ cohort })} onCreate={() => setEditor({ cohort: null })} />
          <CohortEditor projectId={project.id} cohort={editor?.cohort ?? null} open={editor !== null} onOpenChange={(open) => !open && setEditor(null)} />
        </>
      )}
    </AnalyticsPage>
  );
}

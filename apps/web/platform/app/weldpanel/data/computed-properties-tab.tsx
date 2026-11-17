/**
 * Computed properties: a formula over number event properties (checked as it
 * is typed with the query engine's own parser), or the first of 2-5 inputs
 * that is set.
 */

import { useEffect, useState } from 'react';
import { Calculator, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { parseExpression } from '@weldsuite/panel-domain/expression';
import type { PanelComputedPropertyDto, PanelComputedPropertySource } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { PANEL_FILTER_COLUMNS, type PanelFilterColumn } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateWeldPanelComputedProperty,
  useDeleteWeldPanelComputedProperty,
  useUpdateWeldPanelComputedProperty,
  useWeldPanelComputedProperties,
} from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LabeledField } from '../components/labeled-field';
import { PropertyPicker } from '../components/pickers';
import type { FilterLabels } from '../lib/filters';
import { formatDate } from '../lib/format';
import { isConflict, RowActions, type DataTabPermissions } from './shared';

const MIN_INPUTS = 2;
const MAX_INPUTS = 5;

type Kind = 'formula' | 'coalesce';

/** Why a formula does not parse, with a 1-based position, or null. */
export function propertyFormulaProblem(expression: string): { message: string; position: number } | null {
  if (expression.trim() === '') return null;
  const parsed = parseExpression(expression, { identifiers: 'properties' });
  return parsed.ok ? null : { message: parsed.error.message, position: parsed.error.position + 1 };
}

function sourceText(source: PanelComputedPropertySource, columns: FilterLabels['columns']): string {
  return source.source === 'event' ? source.key : columns[source.field];
}

/** "price * quantity" or "coalesce(plan, Page path)": a definition in one line. */
export function definitionSummary(property: PanelComputedPropertyDto, columns: FilterLabels['columns']): string {
  const d = property.definition;
  return d.kind === 'formula' ? d.expression : `coalesce(${d.keys.map((k) => sourceText(k, columns)).join(', ')})`;
}

function ComputedPropertyEditor({
  projectId,
  property,
  open,
  onOpenChange,
}: Readonly<{ projectId: string; property: PanelComputedPropertyDto | null; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.data.computedProperties;
  const tc = t.weldpanel.analytics.common;
  const tf = t.weldpanel.analytics.filters;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<Kind>('formula');
  const [expression, setExpression] = useState('');
  const [inputs, setInputs] = useState<PanelComputedPropertySource[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useCreateWeldPanelComputedProperty();
  const update = useUpdateWeldPanelComputedProperty(projectId);
  const busy = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setName(property?.name ?? '');
    setDescription(property?.description ?? '');
    const d = property?.definition;
    setKind(d?.kind ?? 'formula');
    setExpression(d?.kind === 'formula' ? d.expression : '');
    setInputs(
      d?.kind === 'coalesce'
        ? d.keys
        : [
            { source: 'event', key: '' },
            { source: 'event', key: '' },
          ],
    );
  }, [open, property]);

  const formulaProblem = kind === 'formula' ? propertyFormulaProblem(expression) : null;
  let formulaStatus = tx.kindHints.formula;
  if (formulaProblem) formulaStatus = format(tx.invalid, { position: formulaProblem.position, message: formulaProblem.message });
  else if (expression.trim() !== '') formulaStatus = tx.valid;
  const updateInput = (index: number, next: PanelComputedPropertySource) => setInputs((list) => list.map((k, i) => (i === index ? next : k)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === '') return setProblem(t.weldpanel.analytics.save.nameRequired);
    const formulaOk = kind === 'formula' && expression.trim() !== '' && formulaProblem === null;
    const inputsOk = kind === 'coalesce' && inputs.length >= MIN_INPUTS && inputs.every((k) => k.source === 'column' || k.key !== '');
    if (!formulaOk && !inputsOk) return setProblem(tx.incomplete);
    setProblem(null);
    const definition = kind === 'formula' ? { kind: 'formula' as const, expression: expression.trim() } : { kind: 'coalesce' as const, keys: inputs };
    const body = { name: name.trim(), description: description.trim() === '' ? null : description.trim(), definition };
    try {
      if (property) await update.mutateAsync({ id: property.id, ...body });
      else await create.mutateAsync({ projectId, ...body });
      toast.success(tx.saved);
      onOpenChange(false);
    } catch (error) {
      if (isConflict(error)) setProblem(tx.nameTaken);
      else toast.error(tx.saveFailed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{property ? tx.editTitle : tx.createTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-5">
          <LabeledField label={tc.name} htmlFor="weldpanel-computed-name">
            <Input id="weldpanel-computed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx.namePlaceholder} maxLength={255} autoComplete="off" />
          </LabeledField>
          <LabeledField label={`${tc.description} (${tc.optional})`} htmlFor="weldpanel-computed-description">
            <Textarea id="weldpanel-computed-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} />
          </LabeledField>
          <LabeledField label={tx.kind} htmlFor="weldpanel-computed-kind" hint={tx.kindHints[kind]}>
            <Select value={kind} onValueChange={(next) => setKind(next as Kind)}>
              <SelectTrigger id="weldpanel-computed-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="formula">{tx.kinds.formula}</SelectItem>
                <SelectItem value="coalesce">{tx.kinds.coalesce}</SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>

          {kind === 'formula' ? (
            <LabeledField label={tx.expression} htmlFor="weldpanel-computed-expression">
              <Input
                id="weldpanel-computed-expression"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                placeholder={tx.expressionPlaceholder}
                className="font-mono"
                maxLength={500}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={formulaProblem ? true : undefined}
                aria-describedby="weldpanel-computed-expression-status"
              />
              <p id="weldpanel-computed-expression-status" className={formulaProblem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {formulaStatus}
              </p>
            </LabeledField>
          ) : (
            <div className="grid gap-3">
              <p className="text-sm font-medium">{tx.inputs}</p>
              <p className="text-xs text-muted-foreground">{tx.inputsHint}</p>
              <ol className="grid gap-2">
                {inputs.map((input, index) => {
                  const n = index + 1;
                  return (
                    <li key={index} className="flex items-end gap-2" aria-label={format(tx.inputN, { n })}>
                      <LabeledField label={format(tx.inputN, { n })} htmlFor={`weldpanel-computed-input-${index}-source`} className="w-44 shrink-0">
                        <Select
                          value={input.source}
                          onValueChange={(next) => updateInput(index, next === 'column' ? { source: 'column', field: 'path' } : { source: 'event', key: '' })}
                        >
                          <SelectTrigger id={`weldpanel-computed-input-${index}-source`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="event">{tx.inputSources.event}</SelectItem>
                            <SelectItem value="column">{tx.inputSources.column}</SelectItem>
                          </SelectContent>
                        </Select>
                      </LabeledField>
                      <div className="min-w-0 flex-1">
                        {input.source === 'event' ? (
                          <PropertyPicker projectId={projectId} value={input.key} onChange={(key) => updateInput(index, { source: 'event', key })} ariaLabel={format(tx.inputN, { n })} />
                        ) : (
                          <Select value={input.field} onValueChange={(field) => updateInput(index, { source: 'column', field: field as PanelFilterColumn })}>
                            <SelectTrigger aria-label={format(tx.inputN, { n })}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PANEL_FILTER_COLUMNS.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {tf.columns[c]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      {inputs.length > MIN_INPUTS && (
                        <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0" aria-label={format(tx.removeInput, { n })} onClick={() => setInputs((list) => list.filter((_, i) => i !== index))}>
                          <X />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
              {inputs.length < MAX_INPUTS && (
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setInputs((list) => [...list, { source: 'event', key: '' }])}>
                    <Plus />
                    {tx.addInput}
                  </Button>
                </div>
              )}
            </div>
          )}

          {problem && <InfoBanner variant="danger">{problem}</InfoBanner>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {tc.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? tc.saving : tc.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ComputedPropertiesTab({ projectId, canCreate, canUpdate, canDelete }: Readonly<{ projectId: string } & DataTabPermissions>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.data.computedProperties;
  const tc = t.weldpanel.analytics.common;
  const columns = t.weldpanel.analytics.filters.columns;
  const { data: properties, isLoading, isError, refetch } = useWeldPanelComputedProperties(projectId);
  const remove = useDeleteWeldPanelComputedProperty(projectId);
  const [editing, setEditing] = useState<PanelComputedPropertyDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PanelComputedPropertyDto | null>(null);

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const newButton = canCreate && (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus />
      {tx.new}
    </Button>
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{tx.description}</p>
        {properties && properties.length > 0 && newButton}
      </div>
      {!properties || properties.length === 0 ? (
        <EmptyState icon={Calculator} title={tx.emptyTitle} description={tx.emptyDescription} action={newButton || undefined} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx.columns.name}</TableHead>
                <TableHead>{tx.columns.definition}</TableHead>
                <TableHead className="hidden md:table-cell">{tx.columns.updated}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {properties.map((property) => (
                <TableRow key={property.id}>
                  <TableCell className="max-w-64">
                    <p className="truncate font-medium">{property.name}</p>
                    {property.description && <p className="truncate text-xs text-muted-foreground">{property.description}</p>}
                  </TableCell>
                  <TableCell className="max-w-96 truncate font-mono text-xs text-muted-foreground">{definitionSummary(property, columns)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{formatDate(property.updatedAt, language)}</TableCell>
                  <TableCell>
                    <RowActions name={property.name} onEdit={canUpdate ? () => setEditing(property) : undefined} onDelete={canDelete ? () => setDeleting(property) : undefined} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ComputedPropertyEditor
        projectId={projectId}
        property={editing}
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={format(tx.deleteTitle, { name: deleting?.name ?? '' })}
        description={tx.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(tx.deleted);
            setDeleting(null);
          } catch {
            toast.error(tx.deleteFailed);
          }
        }}
      />
    </div>
  );
}

/** Custom events: several tracked events (each with its own filters) counted under one name. */

import { useEffect, useState } from 'react';
import { Layers, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelCustomEventDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateWeldPanelCustomEvent,
  useDeleteWeldPanelCustomEvent,
  useUpdateWeldPanelCustomEvent,
  useWeldPanelCustomEvents,
} from '@/hooks/queries/use-weldpanel-analysis-queries';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useI18n } from '@/lib/i18n/provider';
import { FilterBuilder } from '../components/filter-builder';
import { LabeledField } from '../components/labeled-field';
import { EventPicker } from '../components/pickers';
import { formatDate } from '../lib/format';
import { isConflict, type DataTabPermissions } from './shared';

const MAX_MATCHES = 10;

interface MatchDraft {
  event: string;
  filters: PanelFilter[];
}

function CustomEventEditor({ projectId, event, open, onOpenChange }: Readonly<{ projectId: string; event: PanelCustomEventDto | null; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.data.customEvents;
  const tc = t.weldpanel.analytics.common;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [matches, setMatches] = useState<MatchDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useCreateWeldPanelCustomEvent();
  const update = useUpdateWeldPanelCustomEvent(projectId);
  const busy = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setName(event?.name ?? '');
    setDescription(event?.description ?? '');
    setMatches(event ? event.definition.match.map((m) => ({ event: m.event, filters: m.filters })) : [{ event: '', filters: [] }]);
  }, [open, event]);

  const updateMatch = (index: number, patch: Partial<MatchDraft>) => setMatches((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === '') return setProblem(t.weldpanel.analytics.save.nameRequired);
    if (matches.length === 0 || matches.some((m) => m.event === '')) return setProblem(tx.incomplete);
    setProblem(null);
    const body = { name: name.trim(), description: description.trim() === '' ? null : description.trim(), definition: { match: matches } };
    try {
      if (event) await update.mutateAsync({ id: event.id, ...body });
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
          <DialogTitle>{event ? tx.editTitle : tx.createTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-5">
          <LabeledField label={tc.name} htmlFor="weldpanel-custom-event-name">
            <Input id="weldpanel-custom-event-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx.namePlaceholder} maxLength={255} autoComplete="off" />
          </LabeledField>
          <LabeledField label={`${tc.description} (${tc.optional})`} htmlFor="weldpanel-custom-event-description">
            <Textarea id="weldpanel-custom-event-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} />
          </LabeledField>
          <div className="grid gap-3">
            <p className="text-sm font-medium">{tx.match}</p>
            <ol className="grid gap-3">
              {matches.map((match, index) => {
                const n = index + 1;
                return (
                  <li key={index} className="grid gap-2 rounded-lg border p-3" aria-label={format(tx.matchEvent, { n })}>
                    <div className="flex items-end gap-2">
                      <LabeledField label={format(tx.matchEvent, { n })} htmlFor={`weldpanel-custom-event-match-${index}`} className="min-w-0 flex-1">
                        <EventPicker
                          id={`weldpanel-custom-event-match-${index}`}
                          projectId={projectId}
                          value={match.event}
                          onChange={(value) => updateMatch(index, { event: value })}
                          ariaLabel={format(tx.matchEvent, { n })}
                          allowCustomEvents={false}
                        />
                      </LabeledField>
                      {matches.length > 1 && (
                        <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0" aria-label={format(tx.removeMatch, { n })} onClick={() => setMatches((list) => list.filter((_, i) => i !== index))}>
                          <X />
                        </Button>
                      )}
                    </div>
                    <div className="grid gap-1">
                      <p className="text-xs text-muted-foreground">{tx.matchFilters}</p>
                      <FilterBuilder compact allowCohort={false} projectId={projectId} filters={match.filters} onChange={(filters) => updateMatch(index, { filters })} />
                    </div>
                  </li>
                );
              })}
            </ol>
            {matches.length < MAX_MATCHES && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setMatches((list) => [...list, { event: '', filters: [] }])}>
                  <Plus />
                  {tx.addMatch}
                </Button>
              </div>
            )}
          </div>
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

export function CustomEventsTab({ projectId, canCreate, canUpdate, canDelete }: Readonly<{ projectId: string } & DataTabPermissions>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.data.customEvents;
  const tc = t.weldpanel.analytics.common;
  const { data: events, isLoading, isError, refetch } = useWeldPanelCustomEvents(projectId);
  const remove = useDeleteWeldPanelCustomEvent(projectId);
  const [editing, setEditing] = useState<PanelCustomEventDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PanelCustomEventDto | null>(null);

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const columns: ColumnDef<PanelCustomEventDto>[] = [
    {
      id: 'name',
      header: tx.columns.name,
      width: 'flex-1 min-w-[160px]',
      render: (event) => <span className="block truncate font-medium">{event.name}</span>,
    },
    {
      id: 'matches',
      header: tx.columns.matches,
      width: 'hidden sm:block sm:w-[280px]',
      render: (event) => (
        <span className="block truncate text-muted-foreground">{event.definition.match.map((m) => (m.filters.length > 0 ? `${m.event} (${m.filters.length})` : m.event)).join(', ')}</span>
      ),
    },
    {
      id: 'description',
      header: tc.description,
      width: 'hidden lg:block lg:w-[240px]',
      render: (event) => <span className="block truncate text-muted-foreground">{event.description ?? '–'}</span>,
    },
    {
      id: 'updated',
      header: tx.columns.updated,
      width: 'hidden md:block md:w-[120px]',
      render: (event) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(event.updatedAt, language)}</span>,
    },
  ];

  const openCreate = () => setCreating(true);

  return (
    <>
      <PanelEntityList<PanelCustomEventDto>
        items={events ?? []}
        isLoading={false}
        columns={columns}
        hideFilter
        onRowClick={canUpdate ? setEditing : undefined}
        onEdit={canUpdate ? setEditing : undefined}
        onDelete={canDelete ? setDeleting : undefined}
        createButton={canCreate ? { label: tx.new, onClick: openCreate } : undefined}
        emptyState={{
          icon: <Layers className="size-8 text-muted-foreground" />,
          title: tx.emptyTitle,
          description: tx.emptyDescription,
          action: canCreate ? { label: tx.new, onClick: openCreate } : undefined,
        }}
      />
      <CustomEventEditor
        projectId={projectId}
        event={editing}
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
    </>
  );
}

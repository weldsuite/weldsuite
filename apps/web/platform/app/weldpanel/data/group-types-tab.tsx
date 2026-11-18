/**
 * Group types: the kinds of group a project collects (at most five), their
 * names, and the group property matched against WeldCRM companies. A type the
 * project collects without a configuration can be configured from its row.
 */

import { useEffect, useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PANEL_MAX_GROUP_TYPES, type PanelGroupTypeDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { PANEL_GROUP_TYPE } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useCreateWeldPanelGroupType, useDeleteWeldPanelGroupType, useUpdateWeldPanelGroupType, useWeldPanelGroupTypes } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LabeledField } from '../components/labeled-field';
import { isConflict, RowActions, type DataTabPermissions } from './shared';

/** `company` → `Company` / `Companies`: starting names for a new type. */
function suggestedNames(groupType: string): { singular: string; plural: string } {
  const words = groupType.replace(/_/g, ' ').trim();
  const singular = words.charAt(0).toUpperCase() + words.slice(1);
  return { singular, plural: singular.endsWith('y') ? `${singular.slice(0, -1)}ies` : `${singular}s` };
}

function GroupTypeEditor({
  projectId,
  groupType,
  open,
  onOpenChange,
}: Readonly<{ projectId: string; groupType: PanelGroupTypeDto | { groupType: string } | null; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.data.groupTypes;
  const tc = t.weldpanel.analytics.common;
  const existing = groupType && 'id' in groupType && groupType.id ? groupType : null;
  const [type, setType] = useState('');
  const [singular, setSingular] = useState('');
  const [plural, setPlural] = useState('');
  const [crm, setCrm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useCreateWeldPanelGroupType(projectId);
  const update = useUpdateWeldPanelGroupType(projectId);
  const busy = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    const initialType = groupType?.groupType ?? '';
    const suggested = suggestedNames(initialType);
    setType(initialType);
    setSingular(existing?.nameSingular ?? (initialType ? suggested.singular : ''));
    setPlural(existing?.namePlural ?? (initialType ? suggested.plural : ''));
    setCrm(existing?.crmMatchProperty ?? '');
  }, [open, groupType, existing]);

  const typeInvalid = type !== '' && !PANEL_GROUP_TYPE.test(type);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (type === '' || typeInvalid || singular.trim() === '' || plural.trim() === '') return setProblem(tx.incomplete);
    setProblem(null);
    const crmMatchProperty = crm.trim() === '' ? null : crm.trim();
    try {
      if (existing?.id) await update.mutateAsync({ id: existing.id, nameSingular: singular.trim(), namePlural: plural.trim(), crmMatchProperty });
      else await create.mutateAsync({ groupType: type, nameSingular: singular.trim(), namePlural: plural.trim(), crmMatchProperty });
      toast.success(tx.saved);
      onOpenChange(false);
    } catch (error) {
      if (isConflict(error)) setProblem(t.weldpanel.explore.data.groupTypes.limitReached.replace('{count}', String(PANEL_MAX_GROUP_TYPES)));
      else toast.error(tx.saveFailed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? tx.editTitle : tx.createTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
          <LabeledField label={tx.groupType} htmlFor="weldpanel-group-type" hint={typeInvalid ? undefined : tx.groupTypeHint}>
            <Input
              id="weldpanel-group-type"
              value={type}
              onChange={(e) => {
                const next = e.target.value.trim().toLowerCase();
                setType(next);
                const suggested = suggestedNames(next);
                if (!existing) {
                  setSingular(suggested.singular);
                  setPlural(suggested.plural);
                }
              }}
              disabled={groupType !== null}
              placeholder="company"
              className="font-mono"
              maxLength={32}
              autoComplete="off"
              aria-invalid={typeInvalid || undefined}
            />
            {typeInvalid && <p className="text-xs text-destructive">{tx.groupTypeInvalid}</p>}
          </LabeledField>
          <div className="grid gap-4 sm:grid-cols-2">
            <LabeledField label={tx.nameSingular} htmlFor="weldpanel-group-singular">
              <Input id="weldpanel-group-singular" value={singular} onChange={(e) => setSingular(e.target.value)} placeholder={tx.nameSingularPlaceholder} maxLength={100} autoComplete="off" />
            </LabeledField>
            <LabeledField label={tx.namePlural} htmlFor="weldpanel-group-plural">
              <Input id="weldpanel-group-plural" value={plural} onChange={(e) => setPlural(e.target.value)} placeholder={tx.namePluralPlaceholder} maxLength={100} autoComplete="off" />
            </LabeledField>
          </div>
          <LabeledField label={`${tx.crmMatchProperty} (${tc.optional})`} htmlFor="weldpanel-group-crm" hint={tx.crmMatchPropertyHint}>
            <Input id="weldpanel-group-crm" value={crm} onChange={(e) => setCrm(e.target.value)} placeholder="domain" className="font-mono" maxLength={64} autoComplete="off" />
          </LabeledField>
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

export function GroupTypesTab({ projectId, canCreate, canUpdate, canDelete }: Readonly<{ projectId: string } & DataTabPermissions>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.data.groupTypes;
  const tc = t.weldpanel.analytics.common;
  const { data: types, isLoading, isError, refetch } = useWeldPanelGroupTypes(projectId);
  const remove = useDeleteWeldPanelGroupType(projectId);
  const [editing, setEditing] = useState<PanelGroupTypeDto | { groupType: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PanelGroupTypeDto | null>(null);

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const slotsTaken = (types ?? []).filter((g) => g.collecting || g.configured).length;
  const full = slotsTaken >= PANEL_MAX_GROUP_TYPES;
  const newButton = canCreate && !full && (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus />
      {tx.new}
    </Button>
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{format(tx.description, { count: PANEL_MAX_GROUP_TYPES })}</p>
        {types && types.length > 0 && newButton}
      </div>
      {full && canCreate && <InfoBanner variant="info">{format(tx.limitReached, { count: PANEL_MAX_GROUP_TYPES })}</InfoBanner>}
      {!types || types.length === 0 ? (
        <EmptyState icon={Building2} title={tx.emptyTitle} description={tx.emptyDescription} action={newButton || undefined} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx.columns.type}</TableHead>
                <TableHead>{tx.columns.names}</TableHead>
                <TableHead className="hidden md:table-cell">{tx.columns.crm}</TableHead>
                <TableHead>{tx.columns.status}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((g) => (
                <TableRow key={g.groupType}>
                  <TableCell className="font-mono text-xs">{g.groupType}</TableCell>
                  <TableCell>
                    {g.configured ? (
                      <span>
                        {g.nameSingular} / {g.namePlural}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{tx.notConfigured}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{g.crmMatchProperty ?? '–'}</TableCell>
                  <TableCell>
                    <SoftBadge tone={g.collecting ? 'success' : 'neutral'}>{g.collecting ? tx.statuses.collecting : tx.statuses.notCollecting}</SoftBadge>
                  </TableCell>
                  <TableCell>
                    {g.configured ? (
                      <RowActions name={g.namePlural} onEdit={canUpdate ? () => setEditing(g) : undefined} onDelete={canDelete ? () => setDeleting(g) : undefined} />
                    ) : (
                      canCreate && (
                        <Button type="button" variant="outline" size="sm" onClick={() => setEditing({ groupType: g.groupType })}>
                          {tx.configure}
                        </Button>
                      )
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <GroupTypeEditor
        projectId={projectId}
        groupType={editing}
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
        title={format(tx.deleteTitle, { name: deleting?.namePlural ?? '' })}
        description={tx.deleteDescription}
        confirmLabel={tc.remove}
        cancelLabel={tc.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleting?.id) return;
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

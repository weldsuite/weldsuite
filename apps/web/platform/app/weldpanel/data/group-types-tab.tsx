/**
 * Group types: the kinds of group a project collects (at most five), their
 * names, and the group property matched against WeldCRM companies. A type the
 * project collects without a configuration can be configured from its row.
 */

import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { PANEL_MAX_GROUP_TYPES, type PanelGroupTypeDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { PANEL_GROUP_TYPE } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useCreateWeldPanelGroupType, useDeleteWeldPanelGroupType, useUpdateWeldPanelGroupType, useWeldPanelGroupTypes } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useI18n } from '@/lib/i18n/provider';
import { LabeledField } from '../components/labeled-field';
import { isConflict, type DataTabPermissions } from './shared';

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

/** A group type as a list row: types that are collected but not configured yet have no id of their own. */
interface GroupRow {
  id: string;
  type: PanelGroupTypeDto;
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

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const slotsTaken = (types ?? []).filter((g) => g.collecting || g.configured).length;
  const full = slotsTaken >= PANEL_MAX_GROUP_TYPES;
  const rows: GroupRow[] = (types ?? []).map((type) => ({ id: type.groupType, type }));
  // A configured type edits; one that is only collected is configured, which needs create.
  const canOpen = (row: GroupRow) => (row.type.configured ? canUpdate : canCreate);
  const open = (row: GroupRow) => setEditing(row.type.configured ? row.type : { groupType: row.type.groupType });

  const columns: ColumnDef<GroupRow>[] = [
    {
      id: 'type',
      header: tx.columns.type,
      width: 'flex-1 min-w-[140px]',
      render: ({ type }) => <span className="block truncate font-mono text-xs">{type.groupType}</span>,
    },
    {
      id: 'names',
      header: tx.columns.names,
      width: 'hidden sm:block sm:w-[220px]',
      render: ({ type }) =>
        type.configured ? (
          <span className="block truncate">
            {type.nameSingular} / {type.namePlural}
          </span>
        ) : (
          <span className="block truncate text-muted-foreground">{tx.notConfigured}</span>
        ),
    },
    {
      id: 'crm',
      header: tx.columns.crm,
      width: 'hidden md:block md:w-[180px]',
      render: ({ type }) => <span className="block truncate font-mono text-xs text-muted-foreground">{type.crmMatchProperty ?? '–'}</span>,
    },
    {
      id: 'status',
      header: tx.columns.status,
      width: 'w-[130px]',
      render: ({ type }) => <SoftBadge tone={type.collecting ? 'success' : 'neutral'}>{type.collecting ? tx.statuses.collecting : tx.statuses.notCollecting}</SoftBadge>,
    },
  ];

  const openCreate = () => setCreating(true);

  return (
    <>
      {full && canCreate && (
        <div className="px-3 pt-3 md:px-4">
          <InfoBanner variant="info">{format(tx.limitReached, { count: PANEL_MAX_GROUP_TYPES })}</InfoBanner>
        </div>
      )}
      <PanelEntityList<GroupRow>
        items={rows}
        isLoading={false}
        columns={columns}
        hideFilter
        onRowClick={(row) => (canOpen(row) ? open(row) : undefined)}
        rowMenu={(row) => {
          const edit = canOpen(row);
          const del = row.type.configured && canDelete;
          if (!edit && !del) return null;
          return (
            <>
              {edit && <DropdownMenuItem onSelect={() => open(row)}>{row.type.configured ? tc.edit : tx.configure}</DropdownMenuItem>}
              {del && (
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(row.type)}>
                  {tc.delete}
                </DropdownMenuItem>
              )}
            </>
          );
        }}
        createButton={canCreate && !full ? { label: tx.new, onClick: openCreate } : undefined}
        emptyState={{
          icon: <Building2 className="size-8 text-muted-foreground" />,
          title: tx.emptyTitle,
          description: tx.emptyDescription,
          action: canCreate && !full ? { label: tx.new, onClick: openCreate } : undefined,
        }}
      />
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
    </>
  );
}

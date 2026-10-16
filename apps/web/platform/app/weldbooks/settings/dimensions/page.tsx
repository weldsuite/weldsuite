import { useCallback, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Layers, MapPin, MoreHorizontal, Pencil, Power, Trash2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowNumberChip, RowText, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import {
  useDeleteDimensionValue,
  useDimensionValues,
  useUpdateDimensionValue,
} from '@/hooks/queries/use-accounting-queries';
import type { DimensionKind, DimensionValue } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { DimensionFormDialog } from './dimension-form-dialog';
import { buildDimensionRows } from './dimension-tree';

/** A dimension value as a list row: where it sits in the tree and what its parent is called. */
interface DimensionListRow {
  id: string;
  value: DimensionValue;
  depth: number;
  name: string;
  parentName: string;
}

/** 409: the value is on bookings or has children. */
function isConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 409;
}

/**
 * Classes and locations (settings). Values tag invoice, bill and journal
 * lines; any financial report can be filtered by them. A value that is on a
 * booking can't be deleted, only deactivated.
 */
export default function DimensionsPage() {
  const { t } = useI18n();
  const td = t.weldbooksUs.setup.dimensions;
  const canCreate = useCan('accounts:create');
  const canUpdate = useCan('accounts:update');
  const canDelete = useCan('accounts:delete');

  const [dimension, setDimension] = useState<DimensionKind>('class');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<{ value: DimensionValue | null } | null>(null);
  const [toDelete, setToDelete] = useState<DimensionValue | null>(null);
  const [inUse, setInUse] = useState<DimensionValue | null>(null);

  const query = useDimensionValues({ dimension, limit: 500 });
  const updateValue = useUpdateDimensionValue();
  const deleteValue = useDeleteDimensionValue();
  const values = useMemo(() => query.data ?? [], [query.data]);

  const nameOf = useCallback(
    (id: string | null) => (id ? (values.find((v) => v.id === id)?.name ?? '') : ''),
    [values],
  );

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const visible = values.filter(
      (v) =>
        (showInactive || v.isActive) &&
        (!term || v.name.toLowerCase().includes(term) || (v.code ?? '').toLowerCase().includes(term)),
    );
    return buildDimensionRows(visible).map<DimensionListRow>(({ value, depth }) => ({
      id: value.id,
      value,
      depth,
      name: value.name,
      parentName: nameOf(value.parentId),
    }));
  }, [values, search, showInactive, nameOf]);

  const setActive = async (value: DimensionValue, isActive: boolean) => {
    try {
      await updateValue.mutateAsync({ id: value.id, data: { isActive } });
      toast.success(isActive ? td.activated : td.deactivated);
    } catch (err) {
      toast.error(td.saveFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    const target = toDelete;
    try {
      await deleteValue.mutateAsync(target.id);
      toast.success(td.deleted);
      setToDelete(null);
    } catch (err) {
      setToDelete(null);
      if (isConflict(err)) setInUse(target);
      else toast.error(td.deleteFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const copy =
    dimension === 'class'
      ? { add: td.addClass, Icon: Layers, empty: td.emptyClasses, emptyDescription: td.emptyClassesDescription }
      : { add: td.addLocation, Icon: MapPin, empty: td.emptyLocations, emptyDescription: td.emptyLocationsDescription };
  const canManage = canUpdate || canDelete;
  const createAction = canCreate ? { label: copy.add, onClick: () => setForm({ value: null }) } : undefined;
  const emptyState =
    values.length > 0
      ? { title: td.noMatches, description: '' }
      : {
          icon: (
            <EmptyStateIllustration>
              <copy.Icon className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: copy.empty,
          description: copy.emptyDescription,
          action: createAction,
        };

  const columns: ColumnDef<DimensionListRow>[] = [
    {
      id: 'name',
      header: td.colName,
      width: 'min-w-[200px] flex-1 gap-2',
      render: ({ value, depth }) => (
        <>
          {depth > 0 ? <span aria-hidden="true" className="flex-shrink-0" style={{ width: `${depth * 1.25}rem` }} /> : null}
          {value.code ? <RowNumberChip>{value.code}</RowNumberChip> : null}
          <RowTitle>{value.name}</RowTitle>
        </>
      ),
    },
    {
      id: 'parent',
      header: td.colParent,
      width: 'w-[200px]',
      render: ({ parentName }) => <RowText>{parentName}</RowText>,
    },
    {
      id: 'status',
      header: td.colStatus,
      width: 'w-[110px]',
      render: ({ value }) => (
        <StatusChip tone={value.isActive ? 'green' : 'gray'}>{value.isActive ? td.active : td.inactive}</StatusChip>
      ),
    },
  ];

  if (query.isError) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground">{td.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {td.retry}
        </Button>
      </div>
    );
  }

  return (
    <>
      {!canCreate && !canUpdate ? (
        <p className="m-4 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{td.noPermission}</p>
      ) : null}

      <WeldbooksEntityList<DimensionListRow>
        items={rows}
        isLoading={query.isLoading}
        columns={columns}
        onRowClick={canUpdate ? (row) => setForm({ value: row.value }) : undefined}
        getRowLabel={(row) => row.name}
        getRowClassName={(row) => (row.value.isActive ? '' : 'opacity-60')}
        renderRowMenu={
          canManage
            ? ({ value }) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`${td.edit}: ${value.name}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canUpdate ? (
                      <>
                        <DropdownMenuItem onSelect={() => setForm({ value })}>
                          <Pencil className="mr-2 h-4 w-4" aria-hidden />
                          {td.edit}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void setActive(value, !value.isActive)}>
                          <Power className="mr-2 h-4 w-4" aria-hidden />
                          {value.isActive ? td.deactivate : td.activate}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {canUpdate && canDelete ? <DropdownMenuSeparator /> : null}
                    {canDelete ? (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => setToDelete(value)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                        {td.delete}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            : undefined
        }
        filters={[]}
        searchQuery={search}
        onSearchChange={setSearch}
        searchFields={['name']}
        searchPlaceholder={td.search}
        leftActionButtons={
          <>
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <Link to="/weldbooks/settings" aria-label={td.back}>
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <Tabs
              value={dimension}
              onValueChange={(next) => {
                setDimension(next === 'location' ? 'location' : 'class');
                setSearch('');
              }}
            >
              <TabsList className="h-8">
                <TabsTrigger value="class">{td.classes}</TabsTrigger>
                <TabsTrigger value="location">{td.locations}</TabsTrigger>
              </TabsList>
            </Tabs>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={showInactive} onCheckedChange={(checked) => setShowInactive(checked === true)} />
              {td.showInactive}
            </label>
          </>
        }
        createButton={createAction}
        emptyState={emptyState}
        noResultsState={{ title: td.noMatches, description: '' }}
      />

      <DimensionFormDialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        dimension={dimension}
        value={form?.value ?? null}
        values={values}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title={td.deleteTitle.replace('{name}', toDelete?.name ?? '')}
        description={td.deleteDescription}
        confirmLabel={td.deleteConfirm}
        cancelLabel={td.cancel}
        variant="destructive"
        loading={deleteValue.isPending}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        open={inUse !== null}
        onOpenChange={(open) => {
          if (!open) setInUse(null);
        }}
        title={td.inUseTitle.replace('{name}', inUse?.name ?? '')}
        description={td.inUseDescription}
        confirmLabel={td.deactivateInstead}
        cancelLabel={td.cancel}
        loading={updateValue.isPending}
        onConfirm={async () => {
          if (!inUse) return;
          const target = inUse;
          setInUse(null);
          if (target.isActive) await setActive(target, false);
        }}
      />
    </>
  );
}

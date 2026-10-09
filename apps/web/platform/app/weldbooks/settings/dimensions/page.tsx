import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Layers, MapPin, MoreHorizontal, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import {
  useDeleteDimensionValue,
  useDimensionValues,
  useUpdateDimensionValue,
} from '@/hooks/queries/use-accounting-queries';
import type { DimensionKind, DimensionValue } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { DimensionFormDialog } from './dimension-form-dialog';
import { buildDimensionRows } from './dimension-tree';

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

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const visible = values.filter(
      (v) =>
        (showInactive || v.isActive) &&
        (!term || v.name.toLowerCase().includes(term) || (v.code ?? '').toLowerCase().includes(term)),
    );
    return buildDimensionRows(visible);
  }, [values, search, showInactive]);
  const nameOf = (id: string | null) => (id ? (values.find((v) => v.id === id)?.name ?? '') : '');

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

  const addLabel = dimension === 'class' ? td.addClass : td.addLocation;
  const EmptyIcon = dimension === 'class' ? Layers : MapPin;

  let body: React.ReactNode;
  if (query.isLoading) {
    body = <PageLoader fullScreen={false} className="min-h-40" />;
  } else if (query.isError) {
    body = (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground">{td.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {td.retry}
        </Button>
      </div>
    );
  } else if (values.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <EmptyIcon className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} aria-hidden />
        <div>
          <p className="font-medium">{dimension === 'class' ? td.emptyClasses : td.emptyLocations}</p>
          <p className="text-sm text-muted-foreground">
            {dimension === 'class' ? td.emptyClassesDescription : td.emptyLocationsDescription}
          </p>
        </div>
        {canCreate ? (
          <Button size="sm" onClick={() => setForm({ value: null })}>
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            {addLabel}
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{td.colName}</TableHead>
              <TableHead className="w-32">{td.colCode}</TableHead>
              <TableHead className="hidden sm:table-cell">{td.colParent}</TableHead>
              <TableHead className="w-28">{td.colStatus}</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ value, depth }) => (
              <TableRow key={value.id} className={value.isActive ? undefined : 'text-muted-foreground'}>
                <TableCell>
                  <span style={{ paddingLeft: `${depth * 1.25}rem` }} className="font-medium">
                    {value.name}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">{value.code ?? ''}</TableCell>
                <TableCell className="hidden sm:table-cell">{nameOf(value.parentId)}</TableCell>
                <TableCell>
                  <Badge variant={value.isActive ? 'secondary' : 'outline'}>
                    {value.isActive ? td.active : td.inactive}
                  </Badge>
                </TableCell>
                <TableCell>
                  {canUpdate || canDelete ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`${td.edit}: ${value.name}`}>
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
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {td.noMatches}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <Link to="/weldbooks/settings">
          <Button variant="ghost" size="icon" aria-label={td.back}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">{td.title}</h1>
          <p className="text-sm text-muted-foreground">{td.description}</p>
        </div>
      </div>

      {!canCreate && !canUpdate ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{td.noPermission}</p>
      ) : null}

      <Tabs
        value={dimension}
        onValueChange={(next) => {
          setDimension(next === 'location' ? 'location' : 'class');
          setSearch('');
        }}
      >
        <TabsList>
          <TabsTrigger value="class">{td.classes}</TabsTrigger>
          <TabsTrigger value="location">{td.locations}</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                type="search"
                aria-label={td.search}
                placeholder={td.search}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="sm:max-w-xs"
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={showInactive} onCheckedChange={(checked) => setShowInactive(checked === true)} />
                {td.showInactive}
              </label>
            </div>
            {canCreate ? (
              <Button size="sm" onClick={() => setForm({ value: null })}>
                <Plus className="mr-1 h-4 w-4" aria-hidden />
                {addLabel}
              </Button>
            ) : null}
          </div>
          {body}
        </CardContent>
      </Card>

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
    </div>
  );
}

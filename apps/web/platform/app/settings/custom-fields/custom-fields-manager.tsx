
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Button } from '@weldsuite/ui/components/button';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Plus, EllipsisVertical, Pencil, Trash2, Copy, ArrowUpDown, Check, ChevronsUpDown, LayoutGrid } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { toast } from 'sonner';
import { ENTITY_TYPES, FIELD_TYPES, getFieldTypeLabel } from './entity-types';
import { FieldDefinitionDialog } from './field-definition-dialog';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';
import {
  useCustomFields,
  useCreateCustomField,
  useUpdateCustomField,
  useDeleteCustomField,
  type CustomFieldDefinition,
  type CreateCustomFieldData,
  type UpdateCustomFieldData,
} from '@/hooks/queries/use-settings-queries';

/** Sentinel entity value for the "All" view (every object type at once). */
const ALL_ENTITY = 'all';

export function CustomFieldsManager() {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.customFields;
  const [selectedEntityType, setSelectedEntityType] = useState<string>(ALL_ENTITY);
  const [entityTypeOpen, setEntityTypeOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingField, setEditingField] = useState<CustomFieldDefinition | null>(null);

  // TanStack Table state
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  // Standard filter row state
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'fieldType',
      label: t.common.labels.type,
      filterType: 'select',
      searchable: true,
      options: FIELD_TYPES.map((ft) => ({ value: ft.value, label: ft.label })),
      getDisplayValue: (value: string) => getFieldTypeLabel(value),
    },
    {
      field: 'required',
      label: ts.required,
      filterType: 'boolean',
      options: [
        { value: 'true', label: st('sweep.settings.customFieldsExtra.yes') },
        { value: 'false', label: st('sweep.settings.customFieldsExtra.no') },
      ],
    },
  ], [t, ts, st]);

  // Sync FilterPills + search → react-table column filters
  useEffect(() => {
    const next: ColumnFiltersState = [];
    if (searchQuery.trim()) {
      next.push({ id: 'name', value: searchQuery.trim() });
    }
    for (const f of activeFilters) {
      if (!f.value) continue;
      if (f.field === 'fieldType') next.push({ id: 'fieldType', value: f.value });
      else if (f.field === 'required') next.push({ id: 'required', value: f.value === 'true' });
    }
    setColumnFilters(next);
  }, [activeFilters, searchQuery]);

  // "All" shows every object type's custom fields at once (no entityType filter).
  const isAll = selectedEntityType === ALL_ENTITY;
  // In "All" mode, new fields default to the first object type.
  const createEntityType = isAll ? ENTITY_TYPES[0].value : selectedEntityType;

  // TanStack Query hooks
  const { data: fieldsResult, isLoading } = useCustomFields(isAll ? undefined : selectedEntityType);
  const createMutation = useCreateCustomField();
  const updateMutation = useUpdateCustomField();
  const deleteMutation = useDeleteCustomField();

  const fields = useMemo(() => fieldsResult ?? [], [fieldsResult]);
  const isPending = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  const handleCreate = useCallback(async (data: CreateCustomFieldData) => {
    try {
      await createMutation.mutateAsync(data);
      toast.success(ts.messages.created);
      setDialogOpen(false);
    } catch {
      toast.error(ts.messages.createFailed);
    }
  }, [createMutation, ts]);

  const handleUpdate = useCallback(async (id: string, data: UpdateCustomFieldData) => {
    try {
      await updateMutation.mutateAsync({ id, data });
      toast.success(ts.messages.updated);
      setDialogOpen(false);
      setEditingField(null);
    } catch {
      toast.error(ts.messages.updateFailed);
    }
  }, [updateMutation, ts]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
      toast.success(ts.messages.deleted);
    } catch {
      toast.error(ts.messages.deleteFailed);
    }
  }, [deleteMutation, ts]);

  const handleDuplicate = useCallback((field: CustomFieldDefinition) => {
    setEditingField(null);
    setDialogOpen(true);
    setTimeout(() => {
      setEditingField({
        ...field,
        id: '',
        name: `${field.name} (copy)`,
        slug: `${field.slug}_copy`,
      });
    }, 0);
  }, []);

  const handleEdit = useCallback((field: CustomFieldDefinition) => {
    setEditingField(field);
    setDialogOpen(true);
  }, []);

  const handleOpenCreate = useCallback(() => {
    setEditingField(null);
    setDialogOpen(true);
  }, []);

  // Column definitions — memoized to prevent infinite re-render loop
  const columns: ColumnDef<CustomFieldDefinition>[] = useMemo(() => [
    {
      accessorKey: 'name',
      header: ({ column }) => (
        <Button
          type="button"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        >
          {t.common.labels.name}
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        </Button>
      ),
      cell: ({ row }) => {
        const cfg = isAll ? ENTITY_TYPES.find((et) => et.value === row.original.entityType) : undefined;
        const Icon = cfg?.icon;
        return (
          <span className="text-sm flex items-center gap-1.5">
            {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
            {row.getValue('name')}
          </span>
        );
      },
    },
    {
      accessorKey: 'fieldType',
      header: ({ column }) => (
        <Button
          type="button"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        >
          {t.common.labels.type}
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        </Button>
      ),
      filterFn: (row, columnId, filterValue) =>
        row.getValue(columnId) === filterValue,
      cell: ({ row }) => (
        <span className="inline-flex items-center h-[22px] px-2 rounded text-xs leading-none font-normal border border-border bg-background text-foreground">
          {getFieldTypeLabel(row.getValue('fieldType'))}
        </span>
      ),
    },
    {
      accessorKey: 'slug',
      header: ts.slug,
      cell: ({ row }) => (
        <span className="text-sm font-mono text-muted-foreground">{row.getValue('slug')}</span>
      ),
    },
    {
      accessorKey: 'required',
      header: ts.required,
      filterFn: (row, columnId, filterValue) =>
        row.getValue(columnId) === filterValue,
      cell: ({ row }) => (
        row.getValue('required') ? (
          <span className="inline-flex items-center h-[22px] px-2 rounded text-xs leading-none bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">{st('sweep.settings.customFieldsExtra.yes')}</span>
        ) : (
          <span className="inline-flex items-center h-[22px] px-2 rounded text-xs leading-none bg-gray-100 dark:bg-secondary text-gray-700 dark:text-muted-foreground">{st('sweep.settings.customFieldsExtra.no')}</span>
        )
      ),
    },
    {
      id: 'actions',
      enableHiding: false,
      cell: ({ row }) => {
        const field = row.original;
        return (
          <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
              >
                <span className="sr-only">{t.common.actions.openMenu}</span>
                <EllipsisVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleEdit(field)}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.common.actions.edit}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleDuplicate(field)}>
                <Copy className="h-4 w-4 mr-0.5" />
                {ts.duplicate}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleDelete(field.id)}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                {t.common.actions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        );
      },
    },
  ], [handleEdit, handleDuplicate, handleDelete, t, ts, isAll, st]);

  const table = useReactTable({
    data: fields,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    state: {
      sorting,
      columnFilters,
      columnVisibility,
    },
  });

  const selectedEntityConfig = ENTITY_TYPES.find(et => et.value === selectedEntityType);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">
          {ts.description}
        </p>
      </div>

      {/* Toolbar + table grouped tight */}
      <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />
          <Popover open={entityTypeOpen} onOpenChange={setEntityTypeOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={entityTypeOpen}
                className="h-8 justify-between font-normal min-w-[160px]"
              >
                {isAll ? st('sweep.settings.customFieldsExtra.all') : (ENTITY_TYPES.find((et) => et.value === selectedEntityType)?.label ?? st('sweep.settings.customFieldsExtra.selectEntityType'))}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0"
              align="start"
            >
              <Command>
                <CommandInput placeholder={st('sweep.settings.customFieldsExtra.searchEntityPlaceholder')} />
                <CommandList>
                  <CommandEmpty>{st('sweep.settings.customFieldsExtra.noEntityFound')}</CommandEmpty>
                  <CommandGroup>
                    <CommandItem
                      value="All"
                      onSelect={() => {
                        setSelectedEntityType(ALL_ENTITY);
                        setEntityTypeOpen(false);
                      }}
                      className="flex items-center justify-between"
                    >
                      <span className="flex items-center gap-1.5">
                        <LayoutGrid className="h-3.5 w-3.5" />
                        {st('sweep.settings.customFieldsExtra.all')}
                      </span>
                      <Check className={cn('h-4 w-4', isAll ? 'opacity-100' : 'opacity-0')} />
                    </CommandItem>
                    {ENTITY_TYPES.map((et) => {
                      const Icon = et.icon;
                      const isCurrent = selectedEntityType === et.value;
                      return (
                        <CommandItem
                          key={et.value}
                          value={et.label}
                          onSelect={() => {
                            setSelectedEntityType(et.value);
                            setEntityTypeOpen(false);
                          }}
                          className="flex items-center justify-between"
                        >
                          <span className="flex items-center gap-1.5">
                            <Icon className="h-3.5 w-3.5" />
                            {et.label}
                          </span>
                          <Check
                            className={cn(
                              'h-4 w-4',
                              isCurrent ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex items-center gap-2">
          <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={ts.filterPlaceholder} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8">
                {ts.columns}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[160px]">
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => {
                  const label = column.id === 'fieldType' ? t.common.labels.type : column.id.charAt(0).toUpperCase() + column.id.slice(1);
                  const checked = column.getIsVisible();
                  return (
                    <DropdownMenuItem
                      key={column.id}
                      onSelect={(e) => {
                        e.preventDefault();
                        column.toggleVisibility(!checked);
                      }}
                      className="flex items-center justify-between pl-2 pr-2"
                    >
                      <span>{label}</span>
                      <Check className={cn('h-4 w-4', checked ? 'opacity-100' : 'opacity-0')} />
                    </DropdownMenuItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" className="h-8" onClick={handleOpenCreate}>
            <Plus className="h-4 w-4 mr-0.5" />
            {ts.addField}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="text-[13.5px]">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <span className="text-sm text-muted-foreground">{ts.loading}</span>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="group h-[50px]"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <p className="text-sm text-muted-foreground">
                    {isAll
                      ? ts.noFields.replace('{entityType}', st('sweep.settings.customFieldsExtra.anyObject'))
                      : ts.noFields.replace('{entityType}', selectedEntityConfig?.label.toLowerCase() ?? '')}
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      </div>

      <FieldDefinitionDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingField(null);
        }}
        entityType={editingField?.entityType ?? createEntityType}
        field={editingField}
        selectableEntity={isAll}
        onSubmit={(data) => {
          if (editingField && editingField.id) {
            handleUpdate(editingField.id, data);
          } else {
            handleCreate({ ...data, entityType: data.entityType ?? createEntityType } as CreateCustomFieldData);
          }
        }}
        isPending={isPending}
      />
    </div>
  );
}

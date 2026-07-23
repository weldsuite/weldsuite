import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import {
  Plus,
  EllipsisVertical,
  Pencil,
  Trash2,
  Check,
  ChevronsUpDown,
  LayoutGrid,
} from 'lucide-react';
import type { ObjectTemplate, ObjectTemplateEntityType } from '@weldsuite/app-api-client/schemas/object-templates';
import { Button } from '@weldsuite/ui/components/button';
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
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { cn } from '@/lib/utils';
import { useSearchParams } from '@/lib/router';
import {
  useObjectTemplates,
  useCreateObjectTemplate,
  useUpdateObjectTemplate,
  useDeleteObjectTemplate,
} from '@/hooks/queries/use-object-templates-queries';
import { TEMPLATE_REGISTRATIONS, getFieldSpec, getRegistration } from './registry';
import { TemplateDialog, type TemplateFormValues } from './template-dialog';

/** Sentinel entity value for the "All" view (every object type at once). */
const ALL_ENTITY = 'all';

export function ObjectTemplatesManager() {
  const ts = getTranslations('settings');
  const tot = ts.objectTemplates;
  // Honor a `?type=` hint (e.g. arriving from a quick-add dialog's "Add
  // template" tab) so we land on the right object, falling back to the first.
  const searchParams = useSearchParams();
  const initialEntity =
    getRegistration(searchParams.get('type') ?? '')?.value ?? ALL_ENTITY;
  const [selectedEntity, setSelectedEntity] = useState<string>(initialEntity);
  const [entityOpen, setEntityOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ObjectTemplate | null>(null);

  // "All" shows every object type's templates at once (no entityType filter).
  const isAll = selectedEntity === ALL_ENTITY;
  const { data: templates, isLoading } = useObjectTemplates(
    isAll ? undefined : (selectedEntity as ObjectTemplateEntityType),
  );
  const createMutation = useCreateObjectTemplate();
  const updateMutation = useUpdateObjectTemplate();
  const deleteMutation = useDeleteObjectTemplate();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const entity = useMemo(() => (isAll ? null : getRegistration(selectedEntity)!), [selectedEntity, isAll]);
  const selectedLabel = isAll ? tot.allLabel : entity!.label;
  // In "All" mode, new templates default to the first registered object type.
  const createEntityType = isAll ? TEMPLATE_REGISTRATIONS[0].value : selectedEntity;
  const rows = templates ?? [];

  const labelForSlug = useCallback(
    (slug: string, entityType: string): string => {
      if (slug.startsWith('cf:')) return slug.slice(3);
      return getFieldSpec(entityType, slug)?.label ?? slug;
    },
    [],
  );

  const handleOpenCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleEdit = (tpl: ObjectTemplate) => {
    setEditing(tpl);
    setDialogOpen(true);
  };

  const handleSubmit = async (values: TemplateFormValues, entityType: ObjectTemplateEntityType) => {
    try {
      if (editing) {
        await updateMutation.mutateAsync({
          id: editing.id,
          data: {
            name: values.name,
            description: values.description || undefined,
            fields: values.fields,
          },
        });
        toast.success(tot.messages.updated);
      } else {
        await createMutation.mutateAsync({
          entityType,
          name: values.name,
          slug: values.slug,
          description: values.description || undefined,
          fields: values.fields,
        });
        toast.success(tot.messages.created);
      }
      setDialogOpen(false);
      setEditing(null);
    } catch {
      toast.error(editing ? tot.messages.updateFailed : tot.messages.createFailed);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
      toast.success(tot.messages.deleted);
    } catch {
      toast.error(tot.messages.deleteFailed);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tot.title}</h1>
        <p className="text-muted-foreground">
          {tot.description}
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Popover open={entityOpen} onOpenChange={setEntityOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={entityOpen}
                className="h-8 justify-between font-normal min-w-[160px]"
              >
                {selectedLabel}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0"
              align="start"
            >
              <Command>
                <CommandInput placeholder={tot.searchObject} />
                <CommandList>
                  <CommandEmpty>{tot.noObjectFound}</CommandEmpty>
                  <CommandGroup>
                    <CommandItem
                      value={tot.allLabel}
                      onSelect={() => {
                        setSelectedEntity(ALL_ENTITY);
                        setEntityOpen(false);
                      }}
                      className="flex items-center justify-between"
                    >
                      <span className="flex items-center gap-1.5">
                        <LayoutGrid className="h-3.5 w-3.5" />
                        {tot.allLabel}
                      </span>
                      <Check className={cn('h-4 w-4', isAll ? 'opacity-100' : 'opacity-0')} />
                    </CommandItem>
                    {TEMPLATE_REGISTRATIONS.map((reg) => {
                      const Icon = reg.icon;
                      const isCurrent = selectedEntity === reg.value;
                      return (
                        <CommandItem
                          key={reg.value}
                          value={reg.label}
                          onSelect={() => {
                            setSelectedEntity(reg.value);
                            setEntityOpen(false);
                          }}
                          className="flex items-center justify-between"
                        >
                          <span className="flex items-center gap-1.5">
                            <Icon className="h-3.5 w-3.5" />
                            {reg.label}
                          </span>
                          <Check className={cn('h-4 w-4', isCurrent ? 'opacity-100' : 'opacity-0')} />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          <Button size="sm" className="h-8" onClick={handleOpenCreate}>
            <Plus className="h-4 w-4 mr-0.5" />
            {tot.newTemplate}
          </Button>
        </div>

        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[13.5px]">{tot.columns.name}</TableHead>
                <TableHead className="text-[13.5px]">{tot.columns.slug}</TableHead>
                <TableHead className="text-[13.5px]">{tot.columns.fields}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    <span className="text-sm text-muted-foreground">{tot.loading}</span>
                  </TableCell>
                </TableRow>
              ) : rows.length ? (
                rows.map((tpl) => (
                  <TableRow key={tpl.id} className="group h-[50px]">
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium flex items-center gap-1.5">
                          {isAll && (() => {
                            const Icon = getRegistration(tpl.entityType)?.icon;
                            return Icon ? <Icon className="h-3.5 w-3.5 text-muted-foreground" /> : null;
                          })()}
                          {tpl.name}
                        </span>
                        {tpl.description && (
                          <span className="text-xs text-muted-foreground">{tpl.description}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-mono text-muted-foreground">{tpl.slug}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {tpl.fields.slice(0, 5).map((slug) => (
                          <span
                            key={slug}
                            className="inline-flex items-center h-[20px] px-1.5 rounded text-xs leading-none border border-border bg-background text-foreground"
                          >
                            {labelForSlug(slug, tpl.entityType)}
                          </span>
                        ))}
                        {tpl.fields.length > 5 && (
                          <span className="text-xs text-muted-foreground">
                            +{tpl.fields.length - 5}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                            >
                              <span className="sr-only">{tot.openMenu}</span>
                              <EllipsisVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEdit(tpl)}>
                              <Pencil className="h-4 w-4 mr-0.5" />
                              {tot.menu.edit}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDelete(tpl.id)}
                              className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                            >
                              <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                              {tot.menu.delete}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    <p className="text-sm text-muted-foreground">
                      {isAll ? tot.noTemplates : tot.noTemplatesForEntity.replace('{entity}', entity!.label.toLowerCase())}
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <TemplateDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        entityType={editing?.entityType ?? createEntityType}
        template={editing}
        onSubmit={handleSubmit}
        isPending={isPending}
        selectableEntity={isAll}
      />
    </div>
  );
}

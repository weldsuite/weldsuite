import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import {
  EmptyStateIllustration,
  FilterPills,
  type ActiveFilter,
  type FilterConfig,
} from '@/components/entity-list';
import {
  Plus,
  Pencil,
  Trash2,
  FileText,
  Loader2,
  EllipsisVertical,
  Search,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { PageLoader } from '@/components/page-loader';
import {
  useTicketTypes,
  useCreateTicketType,
  useUpdateTicketType,
  useDeleteTicketType,
  type TicketTypeConfig,
} from '@/hooks/queries/use-helpdesk-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TicketTypeEditor } from '../ticket-types/ticket-type-editor';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';

// ============================================================================
// Component
// ============================================================================

export function TicketsSettingsClient() {
  const { t } = useI18n();
  const ts = t.helpdesk.ticketsSettings;
  const { data: ticketTypes, isLoading } = useTicketTypes();
  const createTicketType = useCreateTicketType();
  const updateTicketType = useUpdateTicketType();
  const deleteTicketType = useDeleteTicketType();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingType, setEditingType] = useState<TicketTypeConfig | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  const allTypes = ticketTypes || [];

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTypes) if (t.category) set.add(t.category);
    return Array.from(set).map((value) => ({ value, label: value }));
  }, [allTypes]);

  const filterConfigs: FilterConfig[] = useMemo(
    () => [
      {
        field: 'category',
        label: ts.categoryColumn,
        filterType: 'select',
        options: categoryOptions,
      },
    ],
    [categoryOptions, ts],
  );

  const q = searchQuery.trim().toLowerCase();
  const types = allTypes.filter((t) => {
    if (q) {
      const haystack = `${t.name} ${t.description ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    for (const f of activeFilters) {
      if (!f.value) continue;
      if (f.field === 'category' && t.category !== f.value) return false;
    }
    return true;
  });

  const handleCreate = () => {
    setEditingType(null);
    setEditorOpen(true);
  };

  const handleEdit = (type: TicketTypeConfig) => {
    setEditingType(type);
    setEditorOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteTicketType.mutateAsync(deleteId);
      toast.success(t.helpdesk.ticketsPage.ticketTypeDeleted);
    } catch {
      toast.error(t.helpdesk.ticketsPage.failedToDeleteTicketType);
    }
    setDeleteId(null);
  };

  const handleSave = async (type: TicketTypeConfig) => {
    try {
      if (editingType) {
        await updateTicketType.mutateAsync(type);
      } else {
        const { id: _id, createdAt: _c, updatedAt: _u, ...data } = type;
        await createTicketType.mutateAsync(data);
      }
      toast.success(editingType ? t.helpdesk.ticketsPage.ticketTypeUpdated : t.helpdesk.ticketsPage.ticketTypeCreated);
    } catch {
      toast.error(t.helpdesk.ticketsPage.failedToSaveTicketType);
    }
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
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
        </div>

        <div className="flex items-center gap-2">
          <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={ts.searchPlaceholder} />
          <Button size="sm" className="h-8" onClick={handleCreate}>
            <Plus className="h-4 w-4 mr-0.5" />
            {ts.createType}
          </Button>
        </div>
      </div>

        {/* Ticket Types List */}
        {types.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <h3 className="text-lg font-medium mb-1">{ts.noTicketTypesTitle}</h3>
              <p className="text-sm text-muted-foreground">
                {ts.noTicketTypesDesc}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="border rounded-md overflow-hidden bg-white dark:bg-background">
            <table className="w-full bg-white dark:bg-background text-sm">
              <thead className="bg-white dark:bg-background">
                <tr className="border-b bg-white dark:bg-background">
                  <th className="h-[42px] px-3 text-left font-medium text-[13.5px] text-foreground bg-white dark:bg-background">{ts.nameColumn}</th>
                  <th className="h-[42px] px-3 text-left font-medium text-[13.5px] text-foreground bg-white dark:bg-background">{ts.categoryColumn}</th>
                  <th className="h-[42px] px-3 text-left font-medium text-[13.5px] text-foreground bg-white dark:bg-background">{ts.descriptionColumn}</th>
                  <th className="h-[42px] px-3 text-left font-medium text-foreground w-[120px] bg-white dark:bg-background">{ts.attributesColumn}</th>
                  <th className="h-[42px] px-3 text-right font-medium text-foreground w-[60px] bg-white dark:bg-background"></th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-background">
                {types.map((type, idx) => (
                  <tr
                    key={type.id}
                    className={cn(
                      'group bg-white dark:bg-background hover:bg-muted/50 transition-colors',
                      idx !== types.length - 1 && 'border-b'
                    )}
                  >
                    <td className="h-[42px] px-3 align-middle font-medium">{type.name}</td>
                    <td className="h-[42px] px-3 align-middle">
                      {type.category ? (
                        <Badge variant="outline" className="font-mono text-xs !rounded-sm border border-border bg-white dark:bg-background capitalize">
                          {type.category}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="h-[42px] px-3 align-middle text-sm text-muted-foreground">
                      {type.description || ts.noDescription}
                    </td>
                    <td className="h-[42px] px-3 align-middle text-sm text-muted-foreground">
                      {type.fields?.length ?? 0}
                    </td>
                    <td className="h-[42px] px-3 align-middle text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                          >
                            <EllipsisVertical className="h-4 w-4" />
                            <span className="sr-only">{ts.openMenu}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(type)}>
                            <Pencil className="h-4 w-4" />
                            {ts.edit}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleteId(type.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {ts.delete}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {/* Editor Dialog */}
      <TicketTypeEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editingType={editingType}
        onSave={handleSave}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={ts.deleteTitle}
        description={ts.deleteDescription}
        confirmLabel={ts.deleteConfirm}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}

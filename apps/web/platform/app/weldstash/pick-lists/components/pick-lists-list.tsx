import { useState, useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import type { WeldstashPickList } from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';
import { buildPickListColumns } from '../config/pick-list-columns';
import { GeneratePickListDialog } from './generate-pick-list-dialog';

interface PickListsListProps {
  pickLists: WeldstashPickList[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function PickListsList({
  pickLists,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: PickListsListProps) {
  const t = getTranslations('common').weldstash.pickLists;
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/pick-lists');
  const [createOpen, setCreateOpen] = useState(false);
  const columns = useMemo(() => buildPickListColumns(), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pickLists;
    return pickLists.filter(
      (row) =>
        row.pickListNumber.toLowerCase().includes(q) ||
        (row.assignedToName ?? '').toLowerCase().includes(q) ||
        row.status.toLowerCase().includes(q),
    );
  }, [pickLists, search]);

  return (
    <>
      <PanelEntityList<WeldstashPickList>
        items={filtered}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(row) => openObjectPanel({ type: 'pick-list', id: row.id })}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={t.searchPlaceholder}
        createButton={{
          label: t.newPickList,
          onClick: () => setCreateOpen(true),
        }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <ClipboardList className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: t.empty,
          description: t.searchPlaceholder,
          action: {
            label: t.newPickList,
            onClick: () => setCreateOpen(true),
          },
        }}
      />
      {createOpen && <GeneratePickListDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </>
  );
}

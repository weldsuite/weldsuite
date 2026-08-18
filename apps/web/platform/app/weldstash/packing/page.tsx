import { Suspense, useMemo } from 'react';
import { toast } from 'sonner';
import { PackageCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import {
  useInfiniteWeldstashPickLists,
  usePackWeldstashPickList,
  usePrintPackingSlip,
  useShipWeldstashPickList,
  type WeldstashPickList,
} from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';
import { buildPickListColumns } from '../pick-lists/config/pick-list-columns';

function PackingPageContent() {
  const t = getTranslations('common').weldstash;
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/packing');
  const completed = useInfiniteWeldstashPickLists({ limit: 50, status: 'completed' });
  const packed = useInfiniteWeldstashPickLists({ limit: 50, status: 'packed' });
  const pack = usePackWeldstashPickList();
  const ship = useShipWeldstashPickList();
  const printSlip = usePrintPackingSlip();

  const rows = useMemo<WeldstashPickList[]>(() => {
    const a = completed.data?.pages.flatMap((p) => p.data ?? []) ?? [];
    const b = packed.data?.pages.flatMap((p) => p.data ?? []) ?? [];
    return [...a, ...b];
  }, [completed.data, packed.data]);

  const columns = useMemo(() => buildPickListColumns(), []);

  return (
    <PanelEntityList<WeldstashPickList>
      items={rows}
      isLoading={completed.isLoading || packed.isLoading}
      columns={[
        ...columns,
        {
          id: 'actions',
          header: '',
          width: 'w-[280px]',
          render: (row) => (
            <div className="flex justify-end gap-2">
              {row.status === 'completed' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    pack.mutate(row.id, {
                      onSuccess: () => toast.success(t.packing.pack),
                      onError: (err) => toast.error((err as Error).message),
                    });
                  }}
                >
                  {t.packing.pack}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  printSlip.mutate(row.id, {
                    onError: (err) => toast.error((err as Error).message),
                  });
                }}
              >
                {t.packing.printSlip}
              </Button>
              {row.status === 'packed' ? (
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    ship.mutate(row.id, {
                      onSuccess: () => toast.success(t.pickLists.toastShipped),
                      onError: (err) => toast.error((err as Error).message),
                    });
                  }}
                >
                  {t.packing.ship}
                </Button>
              ) : null}
            </div>
          ),
        },
      ]}
      onRowClick={(row) => openObjectPanel({ type: 'pick-list', id: row.id })}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <PackageCheck className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: t.packing.empty,
      }}
    />
  );
}

export default function WeldStashPackingPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <PackingPageContent />
    </Suspense>
  );
}

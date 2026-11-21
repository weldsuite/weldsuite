import { Suspense, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PackageCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
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
  const printSlip = usePrintPackingSlip();
  const ship = useShipWeldstashPickList();
  const [shipId, setShipId] = useState<string | null>(null);

  const rows = useMemo<WeldstashPickList[]>(() => {
    const a = completed.data?.pages.flatMap((p) => p.data ?? []) ?? [];
    const b = packed.data?.pages.flatMap((p) => p.data ?? []) ?? [];
    return [...a, ...b];
  }, [completed.data, packed.data]);

  const columns = useMemo(() => buildPickListColumns(), []);

  const markShipped = async () => {
    if (!shipId) return;
    try {
      await ship.mutateAsync(shipId);
      toast.success(t.packing.toastShipped);
      setShipId(null);
    } catch (err) {
      toast.error((err as Error).message || t.packing.shipFailed);
    }
  };

  return (
    <>
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
                    setShipId(row.id);
                  }}
                >
                  {t.packing.markShipped}
                </Button>
              ) : null}
            </div>
          ),
        },
      ]}
      onRowClick={(row) => openObjectPanel({ type: 'pick-list', id: row.id })}
      objectPanel={{ type: 'pick-list' }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <PackageCheck className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: t.packing.empty,
        description: t.packing.emptyDescription,
      }}
    />
    <ConfirmDialog
      open={Boolean(shipId)}
      onOpenChange={(next) => {
        if (!next) setShipId(null);
      }}
      title={t.packing.markShipped}
      description={t.packing.markShippedDescription}
      confirmLabel={t.packing.markShipped}
      loading={ship.isPending}
      onConfirm={markShipped}
    />
    </>
  );
}

export default function WeldStashPackingPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <PackingPageContent />
    </Suspense>
  );
}

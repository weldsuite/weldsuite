import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { toast } from 'sonner';
import { useState } from 'react';
import { getTranslations } from '@/lib/i18n';
import {
  useAssignWeldstashPickList,
  useWeldstashPickList,
} from '@/hooks/queries/use-weldstash-queries';
import {
  SimpleObjectPanel,
  SectionHeader,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsTab } from '@/components/objects/_shared/focused-tabs';

export function PickListPanel(props: ObjectPanelComponentProps) {
  const t = getTranslations('common').weldstash.pickLists;
  const { id } = props;
  const { data, isLoading, error } = useWeldstashPickList(id);
  const list = data?.data;
  const assign = useAssignWeldstashPickList();
  const [assignee, setAssignee] = useState('');

  return (
    <SimpleObjectPanel
      {...props}
      objectType="pick-list"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!list}
      title={list?.pickListNumber}
      subtitle={list?.status.replace('_', ' ')}
      openHref={list ? `/weldstash/pick-lists?open=${list.id}` : undefined}
      tabs={[detailsTab('Details')]}
      statusBadges={
        list && (
          <Badge variant="outline" className="capitalize">
            {list.status.replace('_', ' ')}
          </Badge>
        )
      }
      fields={
        list
          ? [
              { label: t.colAssignee, value: list.assignedToName || list.assignedTo },
              { label: t.colProgress, value: `${list.pickedItems ?? 0}/${list.totalItems ?? 0}` },
              { label: t.colOrders, value: list.orderIds?.join(', ') },
            ]
          : []
      }
      extras={
        list ? (
          <div className="space-y-4 px-4 pb-4">
            {list.status === 'pending' || list.status === 'assigned' ? (
              <div className="flex gap-2">
                <Input
                  placeholder={t.labelAssignee}
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                />
                <Button
                  size="sm"
                  onClick={() =>
                    assign.mutate(
                      { id: list.id, assignedTo: assignee || null },
                      {
                        onSuccess: () => toast.success(t.toastAssigned),
                        onError: (err) => toast.error((err as Error).message),
                      },
                    )
                  }
                >
                  Assign
                </Button>
              </div>
            ) : null}
            <SectionHeader>Items</SectionHeader>
            <LineItemList
              items={list.items ?? []}
              getKey={(item) => item.id}
              renderLeft={(item) => (
                <span className="truncate">
                  {item.sku ? `${item.sku} · ` : ''}
                  {item.name}
                </span>
              )}
              renderRight={(item) =>
                `${item.quantityPicked ?? 0}/${item.quantityRequired} · ${item.status ?? 'pending'}`
              }
            />
          </div>
        ) : null
      }
    />
  );
}

import { X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { FilterSelect, type FilterSelectOption } from '@weldsuite/ui/components/filter-select';
import { Input } from '@weldsuite/ui/components/input';
import { getTranslations } from '@/lib/i18n';
import {
  APPROVAL_STATUSES,
  FULFILLMENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  approvalStatusLabel,
  fulfillmentStatusLabel,
  orderStatusLabel,
  paymentStatusLabel,
  sourceLabel,
} from '../../lib/orders';

/** The channels an order can come from, in the order the filter offers them. */
export const ORDER_SOURCES = ['manual', 'storefront', 'shopify', 'woocommerce', 'picqer'] as const;

export type OrderFilterKey = 'status' | 'paymentStatus' | 'fulfillmentStatus' | 'approvalStatus' | 'source' | 'channelId' | 'from' | 'to';
export type OrderFilterValues = Partial<Record<OrderFilterKey, string>>;

interface OrderFiltersProps {
  values: OrderFilterValues;
  onChange: (key: OrderFilterKey, value: string | undefined) => void;
  onClear: () => void;
  /** The workspace's channels; the Channel filter shows once there are any. */
  channels?: readonly { id: string; name: string }[];
}

/**
 * The order list's filters: five "all or one" selects and a date range. They
 * live in the URL (the page owns them), so a filtered list can be shared. The
 * date inputs are native: the browser brings the date picker, the keyboard
 * entry and the locale's format.
 */
export function OrderFilters({ values, onChange, onClear, channels = [] }: Readonly<OrderFiltersProps>) {
  const t = getTranslations('commerce').orders.filters;
  const hasFilters = Object.values(values).some(Boolean);

  const options = <T extends string>(list: readonly T[], label: (value: T) => string): FilterSelectOption[] =>
    list.map((value) => ({ value, label: label(value) }));

  return (
    // The <search> landmark: filtering controls are found as one region.
    <search aria-label={t.group} className="flex flex-wrap items-center gap-2">
      <FilterSelect
        value={values.status}
        onChange={(value) => onChange('status', value)}
        options={options(ORDER_STATUSES, orderStatusLabel)}
        allLabel={t.allStatuses}
        ariaLabel={t.status}
      />
      <FilterSelect
        value={values.paymentStatus}
        onChange={(value) => onChange('paymentStatus', value)}
        options={options(PAYMENT_STATUSES, paymentStatusLabel)}
        allLabel={t.allPayments}
        ariaLabel={t.payment}
      />
      <FilterSelect
        value={values.fulfillmentStatus}
        onChange={(value) => onChange('fulfillmentStatus', value)}
        options={options(FULFILLMENT_STATUSES, fulfillmentStatusLabel)}
        allLabel={t.allFulfilments}
        ariaLabel={t.fulfilment}
      />
      <FilterSelect
        value={values.approvalStatus}
        onChange={(value) => onChange('approvalStatus', value)}
        options={options(APPROVAL_STATUSES, approvalStatusLabel)}
        allLabel={t.allApprovals}
        ariaLabel={t.approval}
      />
      <FilterSelect
        value={values.source}
        onChange={(value) => onChange('source', value)}
        options={options(ORDER_SOURCES, sourceLabel)}
        allLabel={t.allSources}
        ariaLabel={t.source}
      />
      {channels.length > 0 && (
        <FilterSelect
          value={values.channelId}
          onChange={(value) => onChange('channelId', value)}
          options={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
          allLabel={t.allChannels}
          ariaLabel={t.channel}
        />
      )}
      <Input
        type="date"
        aria-label={t.from}
        title={t.from}
        value={values.from ?? ''}
        max={values.to || undefined}
        onChange={(event) => onChange('from', event.target.value || undefined)}
        className="h-8 w-[9.5rem] shadow-none"
      />
      <Input
        type="date"
        aria-label={t.to}
        title={t.to}
        value={values.to ?? ''}
        min={values.from || undefined}
        onChange={(event) => onChange('to', event.target.value || undefined)}
        className="h-8 w-[9.5rem] shadow-none"
      />
      {hasFilters && (
        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onClear}>
          <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t.clear}
        </Button>
      )}
    </search>
  );
}

'use client';

import * as React from 'react';
import {
  ArrowLeftRight,
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import {
  useConnectorDefaultFieldMappings,
  useConnectorFieldMappings,
  useUpdateConnectorFieldMappings,
  type ConnectorSyncDef,
} from '@/hooks/queries/use-connector-queries';

const EXTERNAL_FIELDS: Record<string, Array<{ value: string; label: string }>> = {
  product: [
    { value: 'name', label: 'Name' },
    { value: 'title', label: 'Title' },
    { value: 'slug', label: 'Slug' },
    { value: 'sku', label: 'SKU' },
    { value: 'description', label: 'Description' },
    { value: 'short_description', label: 'Short description' },
    { value: 'price', label: 'Price' },
    { value: 'regular_price', label: 'Regular price' },
    { value: 'status', label: 'Status' },
    { value: 'weight', label: 'Weight' },
    { value: 'vendor', label: 'Vendor' },
    { value: 'type', label: 'Type' },
  ],
  order: [
    { value: 'number', label: 'Order number' },
    { value: 'status', label: 'Status' },
    { value: 'currency', label: 'Currency' },
    { value: 'total', label: 'Total' },
    { value: 'subtotal', label: 'Subtotal' },
    { value: 'billing.email', label: 'Billing email' },
    { value: 'billing.first_name', label: 'Billing first name' },
    { value: 'billing.last_name', label: 'Billing last name' },
    { value: 'customer_note', label: 'Customer note' },
  ],
  person: [
    { value: 'email', label: 'Email' },
    { value: 'first_name', label: 'First name' },
    { value: 'last_name', label: 'Last name' },
    { value: 'billing.phone', label: 'Phone' },
    { value: 'billing.address_1', label: 'Address' },
    { value: 'billing.city', label: 'City' },
    { value: 'billing.country', label: 'Country' },
  ],
  party: [
    { value: 'company_name', label: 'Company name' },
    { value: 'firstname', label: 'First name' },
    { value: 'lastname', label: 'Last name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'address1', label: 'Address' },
    { value: 'city', label: 'City' },
    { value: 'country', label: 'Country' },
  ],
  invoice: [
    { value: 'invoice_id', label: 'Invoice id' },
    { value: 'reference', label: 'Reference' },
    { value: 'state', label: 'State' },
    { value: 'currency', label: 'Currency' },
    { value: 'total_price_incl_tax', label: 'Total incl. tax' },
    { value: 'due_date', label: 'Due date' },
  ],
  bill: [
    { value: 'reference', label: 'Reference' },
    { value: 'state', label: 'State' },
    { value: 'currency', label: 'Currency' },
    { value: 'total_price_incl_tax', label: 'Total incl. tax' },
    { value: 'due_date', label: 'Due date' },
  ],
  bank_account: [
    { value: 'name', label: 'Name' },
    { value: 'identifier', label: 'IBAN' },
    { value: 'currency', label: 'Currency' },
  ],
  bank_transaction: [
    { value: 'date', label: 'Date' },
    { value: 'amount', label: 'Amount' },
    { value: 'message', label: 'Message' },
    { value: 'contra_account_name', label: 'Contra account' },
  ],
};

const INTERNAL_FIELDS: Record<string, Array<{ value: string; label: string }>> = {
  product: [
    { value: 'name', label: 'Name' },
    { value: 'slug', label: 'Slug' },
    { value: 'sku', label: 'SKU' },
    { value: 'description', label: 'Description' },
    { value: 'shortDescription', label: 'Short description' },
    { value: 'price', label: 'Price' },
    { value: 'compareAtPrice', label: 'Compare-at price' },
    { value: 'status', label: 'Status' },
    { value: 'weight', label: 'Weight' },
    { value: 'vendor', label: 'Vendor' },
    { value: 'productType', label: 'Product type' },
  ],
  order: [
    { value: 'orderNumber', label: 'Order number' },
    { value: 'status', label: 'Status' },
    { value: 'currency', label: 'Currency' },
    { value: 'total', label: 'Total' },
    { value: 'subtotal', label: 'Subtotal' },
    { value: 'customerEmail', label: 'Customer email' },
    { value: 'customerFirstName', label: 'Customer first name' },
    { value: 'customerLastName', label: 'Customer last name' },
    { value: 'notes', label: 'Notes' },
  ],
  person: [
    { value: 'email', label: 'Email' },
    { value: 'firstName', label: 'First name' },
    { value: 'lastName', label: 'Last name' },
    { value: 'fullName', label: 'Full name' },
    { value: 'directPhone', label: 'Phone' },
    { value: 'address', label: 'Address' },
    { value: 'city', label: 'City' },
    { value: 'country', label: 'Country' },
  ],
  party: [
    { value: 'companyName', label: 'Company name' },
    { value: 'firstName', label: 'First name' },
    { value: 'lastName', label: 'Last name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'address', label: 'Address' },
    { value: 'city', label: 'City' },
    { value: 'country', label: 'Country' },
  ],
  invoice: [
    { value: 'invoiceNumber', label: 'Invoice number' },
    { value: 'reference', label: 'Reference' },
    { value: 'status', label: 'Status' },
    { value: 'currency', label: 'Currency' },
    { value: 'total', label: 'Total' },
    { value: 'dueDate', label: 'Due date' },
  ],
  bill: [
    { value: 'reference', label: 'Reference' },
    { value: 'status', label: 'Status' },
    { value: 'currency', label: 'Currency' },
    { value: 'total', label: 'Total' },
    { value: 'dueDate', label: 'Due date' },
  ],
  bank_account: [
    { value: 'name', label: 'Name' },
    { value: 'iban', label: 'IBAN' },
    { value: 'currency', label: 'Currency' },
  ],
  bank_transaction: [
    { value: 'date', label: 'Date' },
    { value: 'amount', label: 'Amount' },
    { value: 'description', label: 'Description' },
    { value: 'counterpartyName', label: 'Counterparty' },
  ],
};

const DIRECTION_ICONS = {
  inbound: <ArrowDown className="h-3 w-3" />,
  outbound: <ArrowUp className="h-3 w-3" />,
  bidirectional: <ArrowLeftRight className="h-3 w-3" />,
} as const;

interface EditableMapping {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  transformType: 'direct' | 'lookup' | 'format_date' | 'custom';
  transformConfig?: Record<string, unknown>;
  isRequired?: boolean;
}

type EntityLabelKey =
  | 'products'
  | 'orders'
  | 'customers'
  | 'contacts'
  | 'invoices'
  | 'bills'
  | 'bankAccounts'
  | 'bankTransactions';

const ENTITY_LABEL_KEYS = new Map<string, EntityLabelKey>([
  ['product', 'products'],
  ['order', 'orders'],
  ['person', 'customers'],
  ['party', 'contacts'],
  ['invoice', 'invoices'],
  ['bill', 'bills'],
  ['bank_account', 'bankAccounts'],
  ['bank_transaction', 'bankTransactions'],
]);

// Rows have no natural id (the same field pair may appear twice), so each
// mapping object gets a stable React key that survives edits to that row.
const rowKeys = new WeakMap<EditableMapping, string>();
let rowKeyCounter = 0;

function rowKey(mapping: EditableMapping): string {
  let key = rowKeys.get(mapping);
  if (!key) {
    rowKeyCounter += 1;
    key = `mapping-${rowKeyCounter}`;
    rowKeys.set(mapping, key);
  }
  return key;
}

function editedRow(prev: EditableMapping, next: EditableMapping): EditableMapping {
  rowKeys.set(next, rowKey(prev));
  return next;
}

type MappingDirection = EditableMapping['direction'];

const DIRECTION_ORDER: MappingDirection[] = ['bidirectional', 'inbound', 'outbound'];

function nextDirection(current: MappingDirection): MappingDirection {
  return DIRECTION_ORDER[(DIRECTION_ORDER.indexOf(current) + 1) % DIRECTION_ORDER.length]!;
}

interface FieldOption {
  value: string;
  label: string;
}

interface MappingRowProps {
  mapping: EditableMapping;
  externalFields: FieldOption[];
  internalFields: FieldOption[];
  canManage: boolean;
  directionLabel: string;
  onExternalChange: (value: string) => void;
  onCycleDirection: () => void;
  onInternalChange: (value: string) => void;
  onRemove: () => void;
}

function FieldSelect({
  value,
  options,
  disabled,
  onChange,
}: Readonly<{
  value: string;
  options: FieldOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}>) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className="h-7 border-0 bg-transparent px-1 text-xs shadow-none">
        <SelectValue placeholder="…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((f) => (
          <SelectItem key={f.value} value={f.value}>
            {f.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MappingRow({
  mapping,
  externalFields,
  internalFields,
  canManage,
  directionLabel,
  onExternalChange,
  onCycleDirection,
  onInternalChange,
  onRemove,
}: Readonly<MappingRowProps>) {
  return (
    <div className="grid grid-cols-[1fr_28px_1fr_28px] items-center gap-1.5 px-2 py-1.5">
      <FieldSelect
        value={mapping.externalFieldPath}
        options={externalFields}
        disabled={!canManage}
        onChange={onExternalChange}
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground"
        disabled={!canManage}
        title={directionLabel}
        onClick={onCycleDirection}
      >
        {DIRECTION_ICONS[mapping.direction]}
      </Button>
      <FieldSelect
        value={mapping.internalFieldPath}
        options={internalFields}
        disabled={!canManage}
        onChange={onInternalChange}
      />
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground h-7 w-7 hover:text-red-500"
        disabled={!canManage}
        onClick={onRemove}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

export function ConnectorFieldMappingEditor({
  connectionId,
  syncs,
  canManage,
}: Readonly<{
  connectionId: string;
  syncs: ConnectorSyncDef[];
  canManage: boolean;
}>) {
  const { t } = useI18n();
  const tc = t.weldconnect.connectors;
  const entityTypes = React.useMemo(() => {
    const seen = new Set<string>();
    return syncs
      .map((sync) => sync.internalEntity)
      .filter((entity) => {
        if (seen.has(entity)) return false;
        seen.add(entity);
        return true;
      })
      .map((value) => {
        const labelKey = ENTITY_LABEL_KEYS.get(value) ?? null;
        return {
          value,
          label: (labelKey ? tc.types[labelKey] : null) ?? value,
        };
      });
  }, [syncs, tc.types]);

  const [activeEntityType, setActiveEntityType] = React.useState(entityTypes[0]?.value ?? 'product');
  React.useEffect(() => {
    if (entityTypes.length && !entityTypes.some((e) => e.value === activeEntityType)) {
      setActiveEntityType(entityTypes[0]!.value);
    }
  }, [entityTypes, activeEntityType]);

  const { data: mappingsRes, isLoading } = useConnectorFieldMappings(connectionId, activeEntityType);
  const { data: defaultsRes } = useConnectorDefaultFieldMappings(connectionId, activeEntityType);
  const updateMappings = useUpdateConnectorFieldMappings();
  const [localMappings, setLocalMappings] = React.useState<EditableMapping[]>([]);
  const [isDirty, setIsDirty] = React.useState(false);

  React.useEffect(() => {
    if (mappingsRes?.data) {
      setLocalMappings(
        mappingsRes.data.map((m) => ({
          externalFieldPath: m.externalFieldPath,
          internalFieldPath: m.internalFieldPath,
          direction: m.direction,
          transformType: m.transformType,
          transformConfig: m.transformConfig || undefined,
          isRequired: m.isRequired,
        })),
      );
      setIsDirty(false);
    }
  }, [mappingsRes]);

  const editMappings = (updater: (prev: EditableMapping[]) => EditableMapping[]) => {
    setLocalMappings(updater);
    setIsDirty(true);
  };
  const patchMapping = (index: number, patch: (m: EditableMapping) => EditableMapping) =>
    editMappings((prev) => prev.map((m, i) => (i === index ? editedRow(m, patch(m)) : m)));

  const directionLabels = {
    inbound: tc.settings.directionInbound,
    outbound: tc.settings.directionOutbound,
    bidirectional: tc.settings.directionBidirectional,
  } as const;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6">
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={activeEntityType} onValueChange={setActiveEntityType}>
          <TabsList className="h-8">
            {entityTypes.map((et) => (
              <TabsTrigger key={et.value} value={et.value} className="text-xs">
                {et.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={!canManage}
            onClick={() => {
              if (!defaultsRes?.data) return;
              setLocalMappings(
                defaultsRes.data.map((m) => ({
                  externalFieldPath: m.externalFieldPath,
                  internalFieldPath: m.internalFieldPath,
                  direction: m.direction,
                  transformType: m.transformType,
                  transformConfig: m.transformConfig,
                  isRequired: m.isRequired,
                })),
              );
              setIsDirty(true);
            }}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {tc.settings.mappingsDefaults}
          </Button>
          {isDirty && canManage ? (
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={updateMappings.isPending}
              onClick={async () => {
                try {
                  await updateMappings.mutateAsync({
                    connectionId,
                    entityType: activeEntityType,
                    mappings: localMappings,
                  });
                  toast.success(tc.settings.mappingsSaved);
                  setIsDirty(false);
                } catch {
                  toast.error(tc.settings.mappingsSaveFailed);
                }
              }}
            >
              {updateMappings.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              {tc.settings.mappingsSave}
            </Button>
          ) : null}
        </div>
      </div>

      {localMappings.length === 0 ? (
        <p className="text-muted-foreground py-4 text-center text-xs">{tc.settings.mappingsEmpty}</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {localMappings.map((mapping, index) => (
            <MappingRow
              key={rowKey(mapping)}
              mapping={mapping}
              externalFields={EXTERNAL_FIELDS[activeEntityType] ?? []}
              internalFields={INTERNAL_FIELDS[activeEntityType] ?? []}
              canManage={canManage}
              directionLabel={directionLabels[mapping.direction]}
              onExternalChange={(v) => patchMapping(index, (m) => ({ ...m, externalFieldPath: v }))}
              onCycleDirection={() =>
                patchMapping(index, (m) => ({ ...m, direction: nextDirection(m.direction) }))
              }
              onInternalChange={(v) => patchMapping(index, (m) => ({ ...m, internalFieldPath: v }))}
              onRemove={() => editMappings((prev) => prev.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      )}

      {canManage ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            editMappings((prev) => [
              ...prev,
              {
                externalFieldPath: '',
                internalFieldPath: '',
                direction: 'bidirectional',
                transformType: 'direct',
              },
            ]);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {tc.settings.mappingsAdd}
        </Button>
      ) : null}
    </div>
  );
}

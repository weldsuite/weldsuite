/**
 * Convert `CustomFieldDefinition`s from the settings API into grid columns
 * so any user-defined custom field shows up alongside built-in columns.
 *
 * Hidden by default (`visible: false`) so existing per-entity grid view
 * preferences keep their column set. Users opt in via the column picker.
 */

import {
  Calendar,
  CheckSquare,
  DollarSign,
  ExternalLink,
  FileText,
  Hash,
  Mail,
  Phone,
  Star,
  Tag as TagIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FieldType, GridColumnDef } from '@/components/entity-grid';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';

/**
 * Custom field types -> grid field types. Field types the grid can't render
 * (file, user_ref, entity_ref) fall back to plain 'text' so the value is at
 * least visible as a string.
 */
const FIELD_TYPE_MAP: Record<string, FieldType> = {
  text: 'text',
  textarea: 'text',
  number: 'number',
  date: 'date',
  boolean: 'checkbox',
  single_select: 'single-select',
  multi_select: 'multi-select',
  url: 'url',
  email: 'email',
  phone: 'phone',
  currency: 'currency',
  rating: 'rating',
  file: 'text',
  user_ref: 'text',
  entity_ref: 'text',
};

const ICON_MAP: Partial<Record<string, LucideIcon>> = {
  text: FileText,
  textarea: FileText,
  number: Hash,
  date: Calendar,
  boolean: CheckSquare,
  single_select: TagIcon,
  multi_select: TagIcon,
  url: ExternalLink,
  email: Mail,
  phone: Phone,
  currency: DollarSign,
  rating: Star,
};

export interface CustomFieldsToColumnsOptions<TEntity> {
  /** Pull the customFields JSONB blob off the entity. */
  getCustomFields: (entity: TEntity) => Record<string, unknown> | null | undefined;
  /** Build the patch sent to onUpdateEntity. Default: `{ customFields: next }`. */
  buildPatch?: (entity: TEntity, next: Record<string, unknown>) => Record<string, unknown>;
}

export function customFieldsToGridColumns<TEntity>(
  defs: CustomFieldDefinition[] | undefined,
  opts: CustomFieldsToColumnsOptions<TEntity>,
): GridColumnDef<TEntity>[] {
  if (!defs || defs.length === 0) return [];
  const buildPatch = opts.buildPatch ?? ((_e, next) => ({ customFields: next }));

  return defs.map((def): GridColumnDef<TEntity> => {
    const type = FIELD_TYPE_MAP[def.fieldType] ?? 'text';
    const icon = ICON_MAP[def.fieldType] ?? TagIcon;
    const options = def.fieldType === 'single_select' || def.fieldType === 'multi_select'
      ? (def.options ?? []).map((o) => o.value)
      : undefined;
    const selectConfig = def.fieldType === 'single_select' && def.options
      ? Object.fromEntries(
          def.options.map((o) => [
            o.value,
            {
              label: o.label,
              color: 'text-foreground',
              bg: o.color ? '' : 'bg-muted',
            },
          ]),
        )
      : undefined;

    return {
      id: `custom:${def.slug}`,
      name: def.name,
      type,
      width: 160,
      icon,
      visible: false,
      editable: def.fieldType !== 'file',
      sortable: false,
      isCustom: true,
      options,
      selectConfig,
      getValue: (entity) => {
        const cf = opts.getCustomFields(entity);
        const raw = cf ? cf[def.slug] : undefined;
        if (type === 'multi-select') return Array.isArray(raw) ? raw : [];
        if (type === 'checkbox') return !!raw;
        if (type === 'number' || type === 'currency' || type === 'rating') {
          return raw == null || raw === '' ? null : Number(raw);
        }
        return raw ?? null;
      },
      setValue: (entity, value) => {
        const current = opts.getCustomFields(entity) ?? {};
        let normalized: unknown = value;
        if (type === 'multi-select') normalized = Array.isArray(value) ? value : [];
        else if (type === 'checkbox') normalized = !!value;
        else if (type === 'number' || type === 'currency' || type === 'rating') {
          normalized = value == null || value === '' ? null : Number(value);
        } else if (value === '') normalized = null;
        const next = { ...current, [def.slug]: normalized };
        return buildPatch(entity, next);
      },
    };
  });
}

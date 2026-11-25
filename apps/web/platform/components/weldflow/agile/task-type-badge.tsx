import { GlyphBadge } from '@weldsuite/ui/components/glyph-badge';
import type { ItemType, ItemTypeNaming } from '@weldsuite/app-api-client/schemas/flow-agile';
import { useI18n } from '@/lib/i18n/provider';
import { ITEM_TYPE_TONES, itemTypeGlyph, itemTypeOf } from '@/app/weldflow/lib/item-types';

/** The name of an item type in the project's naming ("PBI" or "User story" for a story). */
export function useItemTypeLabel(): (type: ItemType, naming: ItemTypeNaming) => string {
  const { t } = useI18n();
  return (type, naming) => (type === 'story' ? t.flowAgile.itemTypes.story[naming] : t.flowAgile.itemTypes[type]);
}

export interface TaskTypeBadgeProps {
  /** A task's `type` column, as stored; read with `itemTypeOf`. */
  type: string | null | undefined;
  naming: ItemTypeNaming;
  /** A task with a parent always reads as a subtask. */
  hasParent?: boolean;
  featureLevel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/** An item's type as a letter badge: E for an epic, P for a PBI, B for a bug, … */
export function TaskTypeBadge({ type, naming, hasParent, featureLevel, size, className }: Readonly<TaskTypeBadgeProps>) {
  const label = useItemTypeLabel();
  const itemType = itemTypeOf(type, { hasParent, featureLevel });
  return (
    <GlyphBadge
      glyph={itemTypeGlyph(itemType, naming)}
      tone={ITEM_TYPE_TONES[itemType]}
      label={label(itemType, naming)}
      size={size}
      className={className}
    />
  );
}

/**
 * Status and type pills for calendar events.
 *
 * Colour mapping matches the platform's WeldCalendar event dialog so an event
 * reads the same on both surfaces.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import type { BadgeProps } from '@weldsuite/mobile-ui/components/Badge';

import { EVENT_TYPE_COLORS, tint } from '@/lib/brand';
import { eventTypeLabel, priorityLabel, statusLabel, useI18n } from '@/lib/i18n';

type Variant = NonNullable<BadgeProps['variant']>;

const STATUS_VARIANTS: Record<string, Variant> = {
  confirmed: 'success',
  tentative: 'warning',
  cancelled: 'outline',
};

const PRIORITY_VARIANTS: Record<string, Variant> = {
  low: 'secondary',
  normal: 'secondary',
  high: 'warning',
  urgent: 'destructive',
};

export function EventStatusBadge({
  status,
  size = 'sm',
}: {
  status: string;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  return (
    <Badge
      variant={STATUS_VARIANTS[status] ?? 'secondary'}
      size={size}
      label={statusLabel(t, status)}
    />
  );
}

/**
 * `normal` is the column default and carries no signal, so it renders nothing
 * rather than a grey pill on every single event.
 */
export function EventPriorityBadge({
  priority,
  size = 'sm',
}: {
  priority: string | null | undefined;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  if (!priority || priority === 'normal') return null;
  return (
    <Badge
      variant={PRIORITY_VARIANTS[priority] ?? 'secondary'}
      size={size}
      label={priorityLabel(t, priority)}
    />
  );
}

/**
 * Type chip tinted with the event's own colour. Not a `Badge` — the palette is
 * per-type rather than one of the semantic variants.
 */
export function EventTypeChip({ type }: { type: string }) {
  const { t } = useI18n();
  const color = EVENT_TYPE_COLORS[type] ?? EVENT_TYPE_COLORS.other;
  return (
    <View style={[styles.chip, { backgroundColor: tint(color, 0.14) }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.chipText, { color }]}>{eventTypeLabel(t, type)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  chipText: { fontSize: 12, fontWeight: '600' },
});

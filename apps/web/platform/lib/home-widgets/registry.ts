import type { HomeWidgetDefinition, HomeWidgetSlot, WidgetId, WidgetModule } from './types';
import { WIDGET_MODULES } from './types';
import { allWidgets } from './widgets/all';
import { isAppOffered, isFeatureAvailable } from '@/lib/edition';

export const HOME_WIDGETS: Record<WidgetId, HomeWidgetDefinition> = (
  allWidgets as unknown as HomeWidgetDefinition[]
).reduce((acc, w) => {
  acc[w.id] = w;
  return acc;
}, {} as Record<WidgetId, HomeWidgetDefinition>);

export const WIDGETS_BY_MODULE: Record<WidgetModule, HomeWidgetDefinition[]> = WIDGET_MODULES.reduce(
  (acc, m) => {
    acc[m] = (allWidgets as unknown as HomeWidgetDefinition[]).filter((w) => w.module === m);
    return acc;
  },
  {} as Record<WidgetModule, HomeWidgetDefinition[]>,
);

export type NullableSlot = HomeWidgetSlot | null;

/** Default = no widgets picked. Home shows a setup CTA instead. */
export function emptySlots(): [NullableSlot, NullableSlot] {
  return [null, null];
}

/**
 * Edition flags (4.F3): whether this deployment serves what the widget reads,
 * its app's module (the analytics widget: the analytics store).
 */
export function isWidgetOffered(def: HomeWidgetDefinition): boolean {
  return def.module === 'analytics' ? isFeatureAvailable('analytics') : isAppOffered(def.module);
}

export function isWidgetEnabled(id: WidgetId): boolean {
  const def = HOME_WIDGETS[id];
  return !!def && !def.disabled && isWidgetOffered(def);
}

import type { HomeWidgetDefinition, HomeWidgetSlot, WidgetId, WidgetModule } from './types';
import { WIDGET_MODULES } from './types';
import { allWidgets } from './widgets/all';

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

export function isWidgetEnabled(id: WidgetId): boolean {
  return !HOME_WIDGETS[id].disabled;
}

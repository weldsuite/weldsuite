import { z } from 'zod';
import type { HomeWidgetDefinition, HomeWidgetSlot, WidgetId, WidgetModule } from './types';
import { WIDGET_IDS, WIDGET_MODULES } from './types';
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

const widgetIdEnum = z.enum(WIDGET_IDS);

export type NullableSlot = HomeWidgetSlot | null;

const homeWidgetSlotSchema = z
  .object({
    widgetId: widgetIdEnum,
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .transform((slot) => {
    const def = HOME_WIDGETS[slot.widgetId];
    const parsed = def.schema.safeParse(slot.settings);
    return {
      widgetId: slot.widgetId,
      settings: parsed.success ? parsed.data : def.defaultSettings,
    } satisfies HomeWidgetSlot;
  });

const homeWidgetsSchema = z.object({
  slots: z.tuple([homeWidgetSlotSchema.nullable(), homeWidgetSlotSchema.nullable()]),
});

/** Default = no widgets picked. Home shows a setup CTA instead. */
export function emptySlots(): [NullableSlot, NullableSlot] {
  return [null, null];
}

export function isWidgetEnabled(id: WidgetId): boolean {
  return !HOME_WIDGETS[id].disabled;
}

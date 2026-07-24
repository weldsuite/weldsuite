import type { z } from 'zod';
import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

export const WIDGET_MODULES = [
  'analytics',
  'weldmail',
  'weldflow',
  'welddesk',
  'weldcrm',
  'weldconnect',
  'weldmeet',
  'weldchat',
  'weldcalendar',
  'weldcall',
  'welddrive',
  'weldhost',
] as const;
export type WidgetModule = (typeof WIDGET_MODULES)[number];

export const WIDGET_IDS = [
  'analytics-activity',
  'weldmail-inbox',
  'weldflow-my-tasks',
  'weldflow-projects',
  'weldflow-workload',
  'welddesk-tickets',
  'welddesk-emails',
  'welddesk-live-chat',
  'welddesk-slack',
  'welddesk-discord',
  'welddesk-ai-active',
  'welddesk-ai-resolved',
  'welddesk-reviews',
  'weldcrm-my-tasks',
  'weldcrm-pipeline',
  'weldcrm-sequences',
  'weldconnect-executions',
  'weldconnect-workflows',
  'weldmeet-upcoming',
  'weldmeet-history',
  'weldchat-activity',
  'weldchat-dms',
  'weldchat-channels',
  'weldcalendar-week',
  'weldcalendar-schedule',
  'weldcalendar-4day',
  'weldcalendar-day',
  'weldcall-history',
  'welddrive-recent',
  'weldhost-domains',
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

export interface HomeWidgetSlot {
  widgetId: WidgetId;
  settings: Record<string, unknown>;
}

interface HomeWidgetRenderProps<TSettings> {
  settings: TSettings;
}

interface HomeWidgetSettingsFormProps<TSettings> {
  value: TSettings;
  onChange: (next: TSettings) => void;
}

export interface HomeWidgetDefinition<TSettings = Record<string, unknown>> {
  id: WidgetId;
  module: WidgetModule;
  title: string;
  description: string;
  icon: LucideIcon;
  // Schema is contravariant on input — defaults make the parsed output stricter than
  // the inferred input, so we relax the input slot to `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `unknown` breaks assignability for schemas with narrower Input generics; see comment above
  schema: z.ZodType<TSettings, z.ZodTypeDef, any>;
  defaultSettings: TSettings;
  HomeRender: ComponentType<HomeWidgetRenderProps<TSettings>>;
  SettingsForm: ComponentType<HomeWidgetSettingsFormProps<TSettings>>;
  /** Comes-soon widgets are listed but cannot be selected. */
  disabled?: boolean;
}

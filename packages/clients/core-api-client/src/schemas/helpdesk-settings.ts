import { z } from 'zod';

/**
 * Response shapes of /api/helpdesk-settings (desk-api): the workspace's
 * singleton helpdesk settings and the legacy multi-widget settings.
 */

/** A `helpdesk_settings` row: each section is a JSON blob, null until saved. */
export const helpdeskSettingsRowSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    general: z.record(z.unknown()).nullable(),
    tickets: z.record(z.unknown()).nullable(),
    notifications: z.record(z.unknown()).nullable(),
    satisfaction: z.record(z.unknown()).nullable(),
    integrations: z.record(z.unknown()).nullable(),
    customization: z.record(z.unknown()).nullable(),
    automation: z.record(z.unknown()).nullable(),
  })
  .passthrough();

/** A `helpdesk_widget_settings` row. */
export const helpdeskWidgetSettingsRowSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    widgetId: z.string().nullable(),
    widgetName: z.string().nullable(),
    pageHome: z.boolean().nullable(),
    pageChat: z.boolean().nullable(),
    pageHelp: z.boolean().nullable(),
    pageParcelTracking: z.boolean().nullable(),
    pageChangelog: z.boolean().nullable(),
    pageNews: z.boolean().nullable(),
    pageFeedback: z.boolean().nullable(),
    pageAnnouncements: z.boolean().nullable(),
    pageEventSignUp: z.boolean().nullable(),
    colorPrimary: z.string().nullable(),
    colorButton: z.string().nullable(),
    colorButtonText: z.string().nullable(),
    colorLauncher: z.string().nullable(),
    colorHeader: z.string().nullable(),
    colorAccent: z.string().nullable(),
    borderRadius: z.string().nullable(),
    fontSize: z.string().nullable(),
    typographyText: z.string().nullable(),
    typographyBackground: z.string().nullable(),
    startingPage: z.string().nullable(),
    position: z.string().nullable(),
    autoOpen: z.boolean().nullable(),
    showWelcomeMessage: z.boolean().nullable(),
    welcomeMessage: z.string().nullable(),
    companyLogoUrl: z.string().nullable(),
    showBranding: z.boolean().nullable(),
    emailCollection: z.string().nullable(),
    chatBackgroundColor: z.string().nullable(),
    userBubbleColor: z.string().nullable(),
    userBubbleTextColor: z.string().nullable(),
    agentBubbleColor: z.string().nullable(),
    agentBubbleTextColor: z.string().nullable(),
  })
  .passthrough();

/** GET /api/helpdesk-settings: the singleton and the first live widget, either may be missing. */
export const helpdeskSettingsOverviewSchema = z.object({
  settings: helpdeskSettingsRowSchema.nullable(),
  widgetSettings: helpdeskWidgetSettingsRowSchema.nullable(),
});

/** `{ success: true }`: the section PUTs and the widget delete. */
export const helpdeskSettingsOkSchema = z.object({ success: z.literal(true) });

/** PUT /widget and PATCH /widget/enabled: the primary widget, and whether it was just created. */
export const helpdeskPrimaryWidgetRefSchema = z.object({
  id: z.string(),
  widgetId: z.string().nullable(),
  isNew: z.boolean(),
});

/** POST /widgets. */
export const helpdeskWidgetCreatedSchema = z.object({
  id: z.string(),
  widgetId: z.string(),
  widgetName: z.string(),
});

/** PUT /widgets/:widgetId. */
export const helpdeskWidgetRefSchema = z.object({
  id: z.string(),
  widgetId: z.string(),
});

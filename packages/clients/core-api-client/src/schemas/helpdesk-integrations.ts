/**
 * WeldDesk channel integrations (/api/helpdesk-integrations): the Discord and
 * Slack support channels and token-based integrations stored in
 * `helpdesk_channel_integrations`. Response shapes only; the request bodies
 * are validated in the desk-api route.
 */
import { z } from 'zod';

/** An integration row without its OAuth tokens (`sanitizeIntegration`). */
export const helpdeskChannelIntegrationSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    provider: z.string(),
    status: z.string(),
    name: z.string(),
    accountInfo: z.object({ id: z.string().optional(), name: z.string().optional() }).passthrough().nullable(),
    config: z.record(z.unknown()).nullable(),
    tokenExpiresAt: z.string().nullable(),
    lastSyncAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .passthrough();

/** GET /api/helpdesk-integrations. */
export const helpdeskIntegrationListSchema = z.object({ integrations: z.array(helpdeskChannelIntegrationSchema) });

/** POST /token: the new integration's reference (201), or the existing row, now connected (200). */
export const helpdeskTokenSavedSchema = z.union([
  z.object({ id: z.string(), provider: z.string(), status: z.literal('connected') }).strict(),
  helpdeskChannelIntegrationSchema,
]);

/** POST /discord/connect, POST /slack/connect: where to send the browser. */
export const helpdeskOAuthStartSchema = z.object({ authUrl: z.string().url() });

/** GET /discord/servers: every connected guild. */
export const helpdeskDiscordServersSchema = z.object({
  servers: z.array(helpdeskChannelIntegrationSchema.extend({ guildId: z.string().nullable(), guildName: z.string() })),
});

const supportChannelSchema = z
  .object({ channelId: z.string(), channelName: z.string().optional(), enabled: z.boolean() })
  .passthrough();

const ticketPanelSchema = z
  .object({
    channelId: z.string(),
    channelName: z.string().optional(),
    embedTitle: z.string(),
    embedDescription: z.string(),
    embedColor: z.string(),
    buttonText: z.string(),
    buttonStyle: z.number(),
    messageId: z.string().optional(),
  })
  .passthrough();

/** The Discord settings as the platform reads them (`projectDiscordSettings`). */
export const helpdeskDiscordSettingsSchema = z.object({
  supportChannels: z.array(supportChannelSchema),
  processDirectMessages: z.boolean(),
  ignoreBots: z.boolean(),
  supportPrefix: z.string(),
  autoReplyMessage: z.string(),
  botDisplayName: z.string(),
  botAvatarUrl: z.string(),
  ticketPanel: ticketPanelSchema.nullable(),
  integrationId: z.string(),
  guildId: z.string().nullable(),
  /** GET only; PUT leaves it out. */
  guildName: z.string().optional(),
});

/** A provider channel with its configured state. */
export const helpdeskChannelStateSchema = z.object({ channelId: z.string(), channelName: z.string(), enabled: z.boolean() });

/** GET /discord/channels. */
export const helpdeskDiscordChannelsSchema = z.object({
  integrationId: z.string(),
  guildId: z.string(),
  guildName: z.string(),
  channels: z.array(helpdeskChannelStateSchema),
});

/** POST /discord/ticket-panel. */
export const helpdeskTicketPanelPostedSchema = z.object({
  messageId: z.string(),
  ticketPanel: ticketPanelSchema,
  integrationId: z.string(),
});

/** POST /discord/send. */
export const helpdeskDiscordSentSchema = z.object({ success: z.literal(true), messageId: z.string(), message: z.string() });

/** GET and PUT /slack/settings (`projectSlackSettings`). */
export const helpdeskSlackSettingsSchema = z.object({ supportChannels: z.array(supportChannelSchema), ignoreBots: z.boolean() });

/** GET /slack/channels. */
export const helpdeskSlackChannelsSchema = z.object({ teamName: z.string(), channels: z.array(helpdeskChannelStateSchema) });

/** POST /slack/test, POST /:provider/test: a failed probe is still a 200. */
export const helpdeskConnectionTestSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

/** POST /:id/refresh: the row as it was, connected, with the new expiry. */
export const helpdeskTokenRefreshedSchema = helpdeskChannelIntegrationSchema.extend({ tokenExpiresAt: z.string() });

/** DELETE /:idOrProvider. */
export const helpdeskDisconnectedSchema = z.object({ message: z.string() });

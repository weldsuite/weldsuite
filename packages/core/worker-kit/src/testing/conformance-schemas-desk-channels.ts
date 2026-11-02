/** WeldDesk (desk-api) response schemas: the webchat inbox (desk conversations), Discord/Slack integrations and their OAuth callbacks, the public help center. Spread into ROUTES by conformance-schemas.ts. */
import {
  deskConversationAttributeOptionsSchema,
  deskConversationAttributesChangeSchema,
  deskConversationChangeSchema,
  deskConversationDetailSchema,
  deskConversationSchema,
  deskUploadedAttachmentSchema,
} from '@weldsuite/core-api-client/schemas/desk-conversations';
import {
  helpdeskChannelIntegrationSchema,
  helpdeskConnectionTestSchema,
  helpdeskDisconnectedSchema,
  helpdeskDiscordChannelsSchema,
  helpdeskDiscordSentSchema,
  helpdeskDiscordServersSchema,
  helpdeskDiscordSettingsSchema,
  helpdeskIntegrationListSchema,
  helpdeskOAuthStartSchema,
  helpdeskSlackChannelsSchema,
  helpdeskSlackSettingsSchema,
  helpdeskTicketPanelPostedSchema,
  helpdeskTokenRefreshedSchema,
  helpdeskTokenSavedSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-integrations';
import {
  publicHelpcenterArticlePageSchema,
  publicHelpcenterArticleSchema,
  publicHelpcenterConfigSchema,
  publicHelpcenterFeedbackSchema,
  publicHelpcenterFolderSchema,
  publicHelpcenterSearchPageSchema,
} from '@weldsuite/core-api-client/schemas/public-helpcenter';
import type { RouteSchema } from './conformance-schemas';

const HI = '/api/helpdesk-integrations';

export const DESK_CHANNEL_ROUTES: RouteSchema[] = [
  // the webchat inbox
  { method: 'GET', route: '/api/desk/conversations', envelope: 'list', data: deskConversationSchema },
  { method: 'GET', route: '/api/desk/conversations/attributes', envelope: 'single', data: deskConversationAttributeOptionsSchema },
  { method: 'GET', route: '/api/desk/conversations/:id', envelope: 'single', data: deskConversationDetailSchema },
  { method: 'PATCH', route: '/api/desk/conversations/:id', envelope: 'single', data: deskConversationAttributesChangeSchema },
  { method: 'POST', route: '/api/desk/conversations/:id/attachments', envelope: 'single', data: deskUploadedAttachmentSchema },
  { method: 'POST', route: '/api/desk/conversations/:id/reply', envelope: 'single', data: deskConversationChangeSchema },
  { method: 'POST', route: '/api/desk/conversations/:id/manage', envelope: 'single', data: deskConversationChangeSchema },
  // Discord / Slack channel integrations (the OAuth callbacks only redirect)
  { method: 'GET', route: HI, envelope: 'single', data: helpdeskIntegrationListSchema },
  { method: 'POST', route: `${HI}/token`, envelope: 'single', data: helpdeskTokenSavedSchema },
  { method: 'POST', route: `${HI}/discord/connect`, envelope: 'single', data: helpdeskOAuthStartSchema },
  { method: 'GET', route: `${HI}/discord/servers`, envelope: 'single', data: helpdeskDiscordServersSchema },
  { method: 'GET', route: `${HI}/discord/settings`, envelope: 'single', data: helpdeskDiscordSettingsSchema },
  { method: 'PUT', route: `${HI}/discord/settings`, envelope: 'single', data: helpdeskDiscordSettingsSchema },
  { method: 'GET', route: `${HI}/discord/channels`, envelope: 'single', data: helpdeskDiscordChannelsSchema },
  { method: 'POST', route: `${HI}/discord/ticket-panel`, envelope: 'single', data: helpdeskTicketPanelPostedSchema },
  { method: 'POST', route: `${HI}/discord/send`, envelope: 'single', data: helpdeskDiscordSentSchema },
  { method: 'POST', route: `${HI}/slack/connect`, envelope: 'single', data: helpdeskOAuthStartSchema },
  { method: 'GET', route: `${HI}/slack/settings`, envelope: 'single', data: helpdeskSlackSettingsSchema },
  { method: 'PUT', route: `${HI}/slack/settings`, envelope: 'single', data: helpdeskSlackSettingsSchema },
  { method: 'GET', route: `${HI}/slack/channels`, envelope: 'single', data: helpdeskSlackChannelsSchema },
  { method: 'POST', route: `${HI}/slack/test`, envelope: 'single', data: helpdeskConnectionTestSchema },
  { method: 'POST', route: `${HI}/:provider/test`, envelope: 'single', data: helpdeskConnectionTestSchema },
  { method: 'POST', route: `${HI}/:id/refresh`, envelope: 'single', data: helpdeskTokenRefreshedSchema },
  { method: 'DELETE', route: `${HI}/:id`, envelope: 'single', data: helpdeskDisconnectedSchema },
  { method: 'GET', route: `${HI}/:provider`, envelope: 'single', data: helpdeskChannelIntegrationSchema },
  // the public help center (page-based lists answer their own envelope)
  { method: 'GET', route: '/public/helpcenter/config', envelope: 'single', data: publicHelpcenterConfigSchema },
  { method: 'GET', route: '/public/helpcenter/folders', envelope: 'array', data: publicHelpcenterFolderSchema },
  { method: 'GET', route: '/public/helpcenter/articles', envelope: 'body', data: publicHelpcenterArticlePageSchema },
  { method: 'GET', route: '/public/helpcenter/articles/:slug', envelope: 'single', data: publicHelpcenterArticleSchema },
  { method: 'POST', route: '/public/helpcenter/articles/:id/feedback', envelope: 'single', data: publicHelpcenterFeedbackSchema },
  { method: 'GET', route: '/public/helpcenter/search', envelope: 'body', data: publicHelpcenterSearchPageSchema },
];

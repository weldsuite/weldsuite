/**
 * Slack integration definition (reference integration #1).
 *
 * Auth: Slack OAuth v2. The bot token comes back on the token response under
 * `access_token`; the `team.id` is stashed in `settings.teamId` at connect time
 * so the inbound webhook can resolve the workspace from an event's `team_id`.
 */

import type { IntegrationDef } from '../types';

export const slack: IntegrationDef = {
  id: 'slack',
  type: 'slack',
  label: 'Slack',
  description: 'Post messages to channels and start workflows from Slack messages and slash commands.',
  category: 'communication',
  icon: 'slack',
  auth: {
    kind: 'oauth2',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['chat:write', 'channels:read', 'commands'],
    clientIdEnv: 'SLACK_CLIENT_ID',
    clientSecretEnv: 'SLACK_CLIENT_SECRET',
    storeOnSettings: ['team', 'bot_user_id'],
  },
  actions: [
    {
      id: 'slack.post_message',
      name: 'Post Message',
      description: 'Post a message to a Slack channel.',
      inputs: [
        { key: 'channel', label: 'Channel', type: 'string', required: true, placeholder: '#general or C0123ABC' },
        { key: 'text', label: 'Message', type: 'text', required: true, placeholder: 'Hello from WeldConnect' },
      ],
    },
  ],
  triggers: [
    {
      id: 'slack.message',
      name: 'New Message',
      description: 'Triggers when a message is posted in a channel the app belongs to.',
      kind: 'webhook',
      outputFields: ['channel', 'user', 'text', 'ts', 'team_id'],
    },
    {
      id: 'slack.slash_command',
      name: 'Slash Command',
      description: 'Triggers when your custom slash command is invoked.',
      kind: 'webhook',
      outputFields: ['command', 'text', 'user_id', 'channel_id', 'team_id'],
    },
  ],
};

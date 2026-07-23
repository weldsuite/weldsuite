/**
 * Microsoft Teams integration — posts to a channel via an Incoming Webhook URL
 * (no OAuth required; the user pastes the connector webhook URL).
 */

import type { IntegrationDef } from '../types';

export const microsoftTeams: IntegrationDef = {
  id: 'teams',
  type: 'teams',
  label: 'Microsoft Teams',
  description: 'Post messages to a Teams channel via an incoming webhook.',
  category: 'communication',
  icon: 'message-square',
  auth: {
    kind: 'api_key',
    fields: [
      { key: 'webhookUrl', label: 'Incoming Webhook URL', secret: true, placeholder: 'https://outlook.office.com/webhook/...' },
    ],
  },
  actions: [
    {
      id: 'teams.post_message',
      name: 'Post Message',
      description: 'Post a message card to the configured Teams channel.',
      inputs: [
        { key: 'title', label: 'Title', type: 'string', required: false },
        { key: 'text', label: 'Message', type: 'text', required: true },
      ],
    },
  ],
  triggers: [],
};

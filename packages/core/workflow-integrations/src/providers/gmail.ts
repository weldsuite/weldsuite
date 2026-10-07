/**
 * Gmail integration (Google Workspace). Reuses the shared Google OAuth client
 * (see "Provider pattern" in docs/plans/weldconnect.md). Scoped to
 * `gmail.send` only — see GOOGLE_SCOPES.gmail in ./google for why.
 */

import type { IntegrationDef } from '../types';
import { googleAuth, GOOGLE_SCOPES } from './google';

export const gmail: IntegrationDef = {
  id: 'gmail',
  type: 'gmail',
  label: 'Gmail',
  description: 'Send email from your Gmail account and trigger workflows on new mail.',
  category: 'communication',
  icon: 'mail',
  auth: googleAuth(GOOGLE_SCOPES.gmail),
  actions: [
    {
      id: 'gmail.send_email',
      name: 'Send Email',
      description: 'Send an email from the connected Gmail account.',
      inputs: [
        { key: 'integrationId', label: 'Connection', type: 'string', description: 'Which connected Gmail account to send from, when more than one is connected.' },
        { key: 'to', label: 'To', type: 'string', required: true, placeholder: 'jane@acme.com', description: 'Comma-separated recipient addresses. Every resolved address is validated before sending.' },
        { key: 'subject', label: 'Subject', type: 'string', required: true },
        { key: 'body', label: 'Body', type: 'text', required: true },
        { key: 'isHtml', label: 'Body is HTML', type: 'boolean', required: false, description: 'Off treats the body as plain text (escaped and line-broken into HTML).' },
        { key: 'cc', label: 'Cc', type: 'string', required: false },
        { key: 'bcc', label: 'Bcc', type: 'string', required: false },
      ],
    },
  ],
  triggers: [
    {
      id: 'gmail.new_email',
      name: 'New Email',
      description: 'Triggers when a new message arrives in the inbox (optionally matching a Gmail search query).',
      kind: 'poll',
      outputFields: ['id', 'threadId', 'from', 'subject', 'snippet'],
    },
  ],
};

/**
 * Gmail integration (Google Workspace). Reuses the shared Google OAuth client.
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
        { key: 'to', label: 'To', type: 'string', required: true, placeholder: 'jane@acme.com' },
        { key: 'subject', label: 'Subject', type: 'string', required: true },
        { key: 'body', label: 'Body (HTML allowed)', type: 'text', required: true },
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

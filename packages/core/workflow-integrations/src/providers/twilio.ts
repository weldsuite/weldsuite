/**
 * Twilio integration — send SMS/WhatsApp and trigger on inbound messages.
 * Auth: Account SID + Auth Token (HTTP basic). Inbound messages are delivered
 * to a per-connection webhook URL (verified with the X-Twilio-Signature).
 */

import type { IntegrationDef } from '../types';

export const twilio: IntegrationDef = {
  id: 'twilio',
  type: 'twilio',
  label: 'Twilio',
  description: 'Send SMS/WhatsApp messages and start workflows from inbound messages.',
  category: 'communication',
  icon: 'message-circle',
  auth: {
    kind: 'api_key',
    fields: [
      { key: 'accountSid', label: 'Account SID', placeholder: 'ACxxxxxxxx' },
      { key: 'authToken', label: 'Auth Token', secret: true },
      { key: 'fromNumber', label: 'Default From number', placeholder: '+15551234567' },
    ],
  },
  actions: [
    {
      id: 'twilio.send_sms',
      name: 'Send SMS',
      description: 'Send an SMS (or WhatsApp) message.',
      inputs: [
        { key: 'to', label: 'To', type: 'string', required: true, placeholder: '+15557654321' },
        { key: 'body', label: 'Message', type: 'text', required: true },
        { key: 'from', label: 'From (overrides default)', type: 'string', required: false },
      ],
    },
  ],
  triggers: [
    {
      id: 'twilio.inbound_sms',
      name: 'Inbound SMS',
      description: 'Triggers when an SMS is received on your Twilio number.',
      kind: 'webhook',
      outputFields: ['from', 'to', 'body', 'messageSid'],
    },
  ],
};

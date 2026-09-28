/**
 * Telnyx AI Assistant tool definitions for WeldDesk inbound phone.
 */

export function lookupCrmWebhookTool(args: {
  lookupCrmUrl: string;
  toolAuthHeader: string;
}): Record<string, unknown> {
  return {
    type: 'webhook',
    webhook: {
      name: 'lookup_crm',
      description:
        'Look up customers, contacts, and leads in WeldSuite CRM by name, email, or phone. Use the caller phone number when they have not given another identifier.',
      url: args.lookupCrmUrl,
      method: 'POST',
      headers: [{ name: 'Authorization', value: args.toolAuthHeader }],
      body_parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Name, email, or phone to search. Prefer the caller phone from context when they have not provided another identifier.',
          },
        },
      },
    },
  };
}

/** Full tool list for `ai_assistant_start` (overrides the stored assistant tools). */
export function buildDeskPhoneAssistantTools(args: {
  transferToE164?: string | null;
  lookupCrmUrl: string;
  toolAuthHeader: string;
}): unknown[] {
  const tools: unknown[] = [{ type: 'hangup' }, lookupCrmWebhookTool(args)];

  if (args.transferToE164) {
    tools.push({
      type: 'transfer',
      transfer: {
        from: null,
        targets: [{ name: 'Human', to: args.transferToE164 }],
      },
    });
  }

  return tools;
}

export function callerContextInstructions(args: {
  systemPrompt: string;
  callerPhone: string;
  callerName?: string | null;
  customerName?: string | null;
  contactId?: string | null;
  customerId?: string | null;
}): string {
  const lines = [
    args.systemPrompt.trim(),
    '',
    '## Live call context',
    `Caller phone: ${args.callerPhone}`,
  ];
  if (args.callerName) lines.push(`Matched name: ${args.callerName}`);
  if (args.customerName) lines.push(`Matched customer: ${args.customerName}`);
  if (args.contactId) lines.push(`Contact id: ${args.contactId}`);
  if (args.customerId) lines.push(`Customer id: ${args.customerId}`);
  lines.push(
    'Greet the caller by name when a match is present. Use the lookup_crm tool to search CRM if they mention another person or company, or if no match is listed above. Do not invent account details that the tool did not return. If they need a human, transfer them.',
  );
  return lines.join('\n');
}

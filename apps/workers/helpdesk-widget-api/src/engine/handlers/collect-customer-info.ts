import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import type { StepHandler, StepContext, StepResult } from '../types';
import { createBotMessage } from '../helpers';

const CUSTOMER_FIELD_DEFS: Record<string, { label: string; type: string; placeholder: string }> = {
  name: { label: 'Name', type: 'text', placeholder: 'John Doe' },
  email: { label: 'Email', type: 'email', placeholder: 'your@email.com' },
  phone: { label: 'Phone', type: 'phone', placeholder: '+1 555 123 4567' },
  company: { label: 'Company', type: 'text', placeholder: 'Acme Inc.' },
};

export const collectCustomerInfoHandler: StepHandler = {
  type: 'collect_customer_info',
  async execute(ctx: StepContext): Promise<StepResult> {
    if (ctx.inputs.skipIfKnown !== false) {
      const [conv] = await ctx.options.db
        .select({ customerEmail: schema.helpdeskConversations.customerEmail })
        .from(schema.helpdeskConversations)
        .where(eq(schema.helpdeskConversations.id, ctx.state.conversationId))
        .limit(1);
      if (conv?.customerEmail) return { success: true, skipped: true };
    }

    const content = String(ctx.inputs.message || 'Before we get started, could you share your details so we can assist you better?');
    const rawFields = Array.isArray(ctx.inputs.fields) && ctx.inputs.fields.length > 0 ? ctx.inputs.fields : null;

    let fields: Array<{ id: string; label: string; type: string; required: boolean; placeholder?: string }>;
    if (rawFields && typeof rawFields[0] === 'object' && 'label' in (rawFields[0] as any)) {
      fields = rawFields as any;
    } else if (rawFields && typeof rawFields[0] === 'object') {
      fields = (rawFields as Array<{ id: string; required: boolean }>)
        .filter((f) => CUSTOMER_FIELD_DEFS[f.id])
        .map((f) => ({ id: f.id, ...CUSTOMER_FIELD_DEFS[f.id], required: f.required }));
    } else {
      const fieldIds = (rawFields as string[] | null) || ['email'];
      fields = fieldIds
        .filter((id) => typeof id === 'string' && CUSTOMER_FIELD_DEFS[id])
        .map((id) => ({ id, ...CUSTOMER_FIELD_DEFS[id], required: id === 'email' }));
    }

    const messageId = await createBotMessage(ctx.options.db, {
      conversationId: ctx.state.conversationId,
      content,
      metadata: {
        interactiveType: 'collect_input',
        workflowExecutionId: ctx.state.executionId,
        workflowStepId: ctx.stepDef.id,
        fields,
        source: 'workflow',
      },
    });

    await ctx.publish({
      id: messageId,
      conversationId: ctx.state.conversationId,
      content,
      senderId: 'workflow',
      senderName: 'Bot',
      senderType: 'agent',
      timestamp: new Date().toISOString(),
      metadata: { interactiveType: 'collect_input', fields },
    });

    return { __waitingForInput: true, success: true, messageId, conversationId: ctx.state.conversationId };
  },
};

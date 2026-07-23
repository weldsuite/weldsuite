import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';
import { generateId } from '../../lib/id';
import { ensureCustomFieldDefinition, setValues } from '@weldsuite/db/lib/custom-field-values';

export const setConversationAttributeHandler: StepHandler = {
  type: 'set_conversation_attribute',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    const attribute = String(ctx.inputs.attribute);
    const value = ctx.inputs.value;

    const [conversation] = await db
      .select({ customFields: schema.helpdeskConversations.customFields })
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    const existingFields = (conversation?.customFields as Record<string, unknown>) ?? {};
    const updatedFields = { ...existingFields, [attribute]: value };

    await db
      .update(schema.helpdeskConversations)
      .set({
        customFields: updatedFields,
        updatedAt: new Date(),
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    // Pile B dual-write: mirror the attribute into the typed value store,
    // auto-creating a text definition when the attribute has none yet. Blob
    // above stays the source of truth until Phase 4; never fail the step.
    try {
      const def = await ensureCustomFieldDefinition(db, generateId, 'conversation', attribute);
      await setValues(db, 'conversation', conversationId, { [attribute]: value }, {
        generateId,
        definitions: [def],
      });
    } catch (err) {
      console.warn(`[set-conversation-attribute] value mirror failed for conversation ${conversationId}`, err);
    }

    return { success: true, attribute, value, conversationId };
  },
};

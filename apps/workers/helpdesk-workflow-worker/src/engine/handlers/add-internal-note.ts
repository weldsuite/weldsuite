import type { StepHandler, StepContext, StepResult } from '../../types';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';
import { generateId } from '../../lib/id';

export const addInternalNoteHandler: StepHandler = {
  type: 'add_internal_note',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const messageId = generateId('msg');

    await ctx.options.db.insert(schema.helpdeskConversationMessages).values({
      id: messageId,
      conversationId,
      content: String(ctx.inputs.content || ''),
      authorType: 'agent',
      authorId: 'system',
      authorName: 'System',
      type: 'note',
      isPublic: false,
      isInternal: true,
      status: 'sent',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { success: true, messageId, conversationId };
  },
};

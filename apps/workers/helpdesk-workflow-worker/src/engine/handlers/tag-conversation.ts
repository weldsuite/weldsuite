import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';

export const tagConversationHandler: StepHandler = {
  type: 'tag_conversation',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    const mode = String(ctx.inputs.mode || 'add');
    const inputTags = (Array.isArray(ctx.inputs.tags) ? ctx.inputs.tags : []).map(String);

    const [conversation] = await db
      .select({ tags: schema.helpdeskConversations.tags })
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    const currentTags: string[] = (conversation?.tags as string[]) ?? [];
    let newTags: string[];

    switch (mode) {
      case 'add': newTags = [...new Set([...currentTags, ...inputTags])]; break;
      case 'remove': newTags = currentTags.filter(t => !inputTags.includes(t)); break;
      case 'replace': newTags = inputTags; break;
      default: newTags = [...new Set([...currentTags, ...inputTags])];
    }

    await db
      .update(schema.helpdeskConversations)
      .set({ tags: newTags, updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    return { success: true, conversationId, mode, tags: newTags };
  },
};

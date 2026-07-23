/**
 * AI Classify Step Handler
 *
 * Uses a Mastra Agent to classify the conversation into a category
 * based on recent message history. Updates the conversation's category
 * field in the database.
 */

import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { schema } from '../../db';
import { createHelpdeskAgent } from '../../lib/helpdesk-agent-stub';

export const aiClassifyHandler: StepHandler = {
  type: 'ai_classify',

  async execute(ctx: StepContext): Promise<StepResult> {
    const { db, env, conversationId, workspaceId } = ctx.options;

    // Load conversation
    const [conversation] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    if (!conversation) return { success: false, error: 'Conversation not found' };

    // Load last 10 messages for classification context
    const recentMessages = await db
      .select({
        content: schema.helpdeskConversationMessages.content,
        authorType: schema.helpdeskConversationMessages.authorType,
        authorName: schema.helpdeskConversationMessages.authorName,
      })
      .from(schema.helpdeskConversationMessages)
      .where(
        and(
          eq(schema.helpdeskConversationMessages.conversationId, conversationId),
          isNull(schema.helpdeskConversationMessages.deletedAt),
          eq(schema.helpdeskConversationMessages.isPublic, true),
        ),
      )
      .orderBy(desc(schema.helpdeskConversationMessages.createdAt))
      .limit(10);

    recentMessages.reverse();

    // Build transcript for classification
    const transcript = recentMessages
      .map((m) => `${m.authorType === 'customer' ? 'Customer' : m.authorName || 'Agent'}: ${m.content ?? ''}`)
      .join('\n');

    if (!transcript.trim()) {
      return { success: false, error: 'No messages to classify' };
    }

    const modelId = ctx.inputs.model
      ? String(ctx.inputs.model).includes('/')
        ? String(ctx.inputs.model)
        : `openai/${ctx.inputs.model}`
      : 'openai/gpt-4o';

    // Create Mastra agent for classification
    const agent = createHelpdeskAgent({
      env,
      db,
      workspaceId,
      modelId,
      agentName: 'Classifier',
      maxTokens: 200,
    });

    let category = 'general';
    let confidence = 0;

    try {
      const response = await agent.generate([
        {
          role: 'user' as const,
          content: `Classify this customer conversation into a category. Return the most fitting category and your confidence level.\n\nConversation:\n${transcript}\n\nRespond in the format:\nCategory: <category>\nConfidence: <number between 0 and 100>`,
        },
      ]);

      const responseText = typeof response === 'object' && response !== null && 'text' in response
        ? String((response as any).text)
        : String(response);

      // Parse category from response
      const categoryMatch = responseText.match(/Category:\s*(.+)/i);
      if (categoryMatch) {
        category = categoryMatch[1].trim().toLowerCase().replace(/[^a-z0-9_\s-]/g, '').replace(/\s+/g, '_');
      }

      // Parse confidence from response
      const confidenceMatch = responseText.match(/Confidence:\s*(\d+)/i);
      if (confidenceMatch) {
        confidence = Math.min(100, Math.max(0, parseInt(confidenceMatch[1], 10)));
      }
    } catch (err) {
      console.error('[AI Classify] Agent error:', err);
      return { success: false, error: 'AI classification failed' };
    }

    // Update conversation category
    await db
      .update(schema.helpdeskConversations)
      .set({
        category,
        updatedAt: new Date(),
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    return {
      success: true,
      category,
      confidence,
      conversationId,
    };
  },
};

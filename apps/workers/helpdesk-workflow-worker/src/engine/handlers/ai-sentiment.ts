/**
 * AI Sentiment Step Handler
 *
 * Uses a Mastra Agent to analyze customer sentiment from recent messages.
 * Updates the conversation metadata with the detected sentiment.
 */

import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { schema } from '../../db';
import { createHelpdeskAgent } from '../../lib/helpdesk-agent-stub';

export const aiSentimentHandler: StepHandler = {
  type: 'ai_sentiment',

  async execute(ctx: StepContext): Promise<StepResult> {
    const { db, env, conversationId, workspaceId } = ctx.options;

    // Load conversation for existing metadata
    const [conversation] = await db
      .select({
        metadata: schema.helpdeskConversations.metadata,
      })
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    if (!conversation) return { success: false, error: 'Conversation not found' };

    // Load last 5 customer messages for sentiment analysis
    const customerMessages = await db
      .select({
        content: schema.helpdeskConversationMessages.content,
      })
      .from(schema.helpdeskConversationMessages)
      .where(
        and(
          eq(schema.helpdeskConversationMessages.conversationId, conversationId),
          eq(schema.helpdeskConversationMessages.authorType, 'customer'),
          isNull(schema.helpdeskConversationMessages.deletedAt),
        ),
      )
      .orderBy(desc(schema.helpdeskConversationMessages.createdAt))
      .limit(5);

    customerMessages.reverse();

    const customerText = customerMessages
      .map((m) => m.content ?? '')
      .filter(Boolean)
      .join('\n');

    if (!customerText.trim()) {
      return { success: false, error: 'No customer messages to analyze' };
    }

    const modelId = ctx.inputs.model
      ? String(ctx.inputs.model).includes('/')
        ? String(ctx.inputs.model)
        : `openai/${ctx.inputs.model}`
      : 'openai/gpt-4o';

    // Create Mastra agent for sentiment analysis
    const agent = createHelpdeskAgent({
      env,
      db,
      workspaceId,
      modelId,
      agentName: 'Sentiment Analyzer',
      maxTokens: 50,
    });

    let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral';

    try {
      const response = await agent.generate([
        {
          role: 'user' as const,
          content: `Analyze the customer's sentiment. Respond with exactly one word: positive, neutral, or negative.\n\nCustomer messages:\n${customerText}`,
        },
      ]);

      const responseText = typeof response === 'object' && response !== null && 'text' in response
        ? String((response as any).text).trim().toLowerCase()
        : String(response).trim().toLowerCase();

      // Extract sentiment from response
      if (responseText.includes('positive')) {
        sentiment = 'positive';
      } else if (responseText.includes('negative')) {
        sentiment = 'negative';
      } else {
        sentiment = 'neutral';
      }
    } catch (err) {
      console.error('[AI Sentiment] Agent error:', err);
      return { success: false, error: 'AI sentiment analysis failed' };
    }

    // Update conversation metadata with sentiment
    const existingMetadata = (conversation.metadata as Record<string, unknown>) || {};
    const updatedMetadata = {
      ...existingMetadata,
      sentiment,
      analyzedAt: new Date().toISOString(),
    };

    await db
      .update(schema.helpdeskConversations)
      .set({
        metadata: updatedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    return {
      success: true,
      sentiment,
      conversationId,
    };
  },
};

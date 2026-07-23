/**
 * AI Summarize Step Handler
 *
 * Uses a Mastra Agent to summarize the conversation and saves
 * the summary as an internal note on the conversation.
 */

import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { createHelpdeskAgent } from '../../lib/helpdesk-agent-stub';

export const aiSummarizeHandler: StepHandler = {
  type: 'ai_summarize',

  async execute(ctx: StepContext): Promise<StepResult> {
    const { db, env, conversationId, workspaceId } = ctx.options;

    // Load conversation
    const [conversation] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    if (!conversation) return { success: false, error: 'Conversation not found' };

    // Load last 20 messages for summary context
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
      .limit(20);

    recentMessages.reverse();

    // Build transcript
    const transcript = recentMessages
      .map((m) => `${m.authorType === 'customer' ? 'Customer' : m.authorName || 'Agent'}: ${m.content ?? ''}`)
      .join('\n');

    if (!transcript.trim()) {
      return { success: false, error: 'No messages to summarize' };
    }

    const modelId = ctx.inputs.model
      ? String(ctx.inputs.model).includes('/')
        ? String(ctx.inputs.model)
        : `openai/${ctx.inputs.model}`
      : 'openai/gpt-4o';

    // Create Mastra agent for summarization
    const agent = createHelpdeskAgent({
      env,
      db,
      workspaceId,
      modelId,
      agentName: 'Summarizer',
      maxTokens: 300,
    });

    let summary = '';

    try {
      const response = await agent.generate([
        {
          role: 'user' as const,
          content: `Summarize this customer support conversation in 2-3 sentences.\n\nConversation:\n${transcript}`,
        },
      ]);

      summary = typeof response === 'object' && response !== null && 'text' in response
        ? String((response as any).text).trim()
        : String(response).trim();
    } catch (err) {
      console.error('[AI Summarize] Agent error:', err);
      return { success: false, error: 'AI summarization failed' };
    }

    if (!summary) {
      return { success: false, error: 'Empty summary generated' };
    }

    // Save summary as internal note
    const messageId = generateId('msg');
    const now = new Date();

    await db.insert(schema.helpdeskConversationMessages).values({
      id: messageId,
      conversationId,
      content: summary,
      authorType: 'agent',
      authorId: 'system',
      authorName: 'AI Summary',
      type: 'note',
      isPublic: false,
      isInternal: true,
      status: 'sent',
      isRead: false,
      metadata: {
        aiGenerated: true,
        summaryType: 'conversation_summary',
        model: modelId,
      },
      createdAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      summary,
      messageId,
      conversationId,
    };
  },
};

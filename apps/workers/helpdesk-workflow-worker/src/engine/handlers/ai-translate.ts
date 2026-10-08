/**
 * AI Translate Step Handler
 *
 * Uses a Mastra Agent to translate the last customer message
 * into a specified target language.
 */

import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { schema } from '../../db';
import { createHelpdeskAgent, resolveModelId } from '../../lib/helpdesk-agent-stub';
import { asText } from '@weldsuite/text';

export const aiTranslateHandler: StepHandler = {
  type: 'ai_translate',

  async execute(ctx: StepContext): Promise<StepResult> {
    const { db, env, conversationId, workspaceId } = ctx.options;
    const targetLanguage = asText(ctx.inputs.targetLanguage || 'en');

    // Get the last customer message
    const [lastCustomerMessage] = await db
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
      .limit(1);

    if (!lastCustomerMessage?.content) {
      return { success: false, error: 'No customer message found to translate' };
    }

    const originalContent = lastCustomerMessage.content;

    const modelId = resolveModelId(ctx.inputs.model);

    // Create Mastra agent for translation
    const agent = createHelpdeskAgent({
      env,
      db,
      workspaceId,
      modelId,
      agentName: 'Translator',
      maxTokens: 500,
    });

    let translatedContent = '';

    try {
      const response = await agent.generate([
        {
          role: 'user' as const,
          content: `Translate the following message to ${targetLanguage}. Only output the translation, nothing else.\n\n${originalContent}`,
        },
      ]);

      translatedContent = typeof response === 'object' && response !== null && 'text' in response
        ? String((response as any).text).trim()
        : String(response).trim();
    } catch (err) {
      console.error('[AI Translate] Agent error:', err);
      return { success: false, error: 'AI translation failed' };
    }

    if (!translatedContent) {
      return { success: false, error: 'Empty translation generated' };
    }

    return {
      success: true,
      originalContent,
      translatedContent,
      targetLanguage,
    };
  },
};

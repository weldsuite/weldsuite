/**
 * Mail AI routes — /api/mail-ai/*
 *
 * WeldMail's AI writing + triage surface, rebuilt on `@weldsuite/ai`
 * (Cloudflare AI Gateway) after the agent-worker teardown. Every handler
 * returns the `{ success, data }` shape the platform hooks already expect.
 *
 *  POST /draft          compose an email from a prompt          → { subject, body }
 *  POST /improve-text   rewrite/shorten/expand/formalize/…      → { text }
 *  POST /auto-draft     suggest a next email from inbox context → { subject, body }
 *  POST /reply          suggest a reply body                    → { body }
 *  POST /smart-replies  3 quick reply options                   → { replies }
 *  POST /inbox-summary  summarise recent inbox                  → { summary }
 *  POST /label          classify one message (persists)         → classification
 *  POST /label/batch    classify many messages (persists)       → { results }
 *
 * Metered against the prepaid credit wallet (serviceType `ai_tokens`): each
 * handler resolves metering, the service hard-gates on balance before the call
 * and consumes credits for the actual tokens after. Insufficient balance →
 * 402. See `services/ai/billing.ts`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import {
  MailAiError,
  draftEmail,
  improveText,
  autoDraft,
  replySuggestion,
  smartReplies,
  inboxSummary,
  classifyMessage,
  classifyMessagesBatch,
  type ClassificationResult,
} from '../../services/mail/ai';
import {
  resolveAiMetering,
  InsufficientAiCreditsError,
  type AiMetering,
} from '../../services/ai/billing';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Resolve the credit-metering context for the current request. */
function metersFor(c: AppContext): Promise<AiMetering | null> {
  return resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));
}

const draftBody = z.object({
  prompt: z.string().min(1),
  replyToMessageId: z.string().nullish(),
  accountId: z.string().nullish(),
  tone: z.enum(['professional', 'friendly', 'casual']).optional(),
  length: z.enum(['short', 'medium', 'long']).optional(),
  modelId: z.string().nullish(),
});

const improveBody = z.object({
  text: z.string().min(1),
  action: z.enum(['improve', 'shorten', 'expand', 'formalize', 'make_friendly']),
  accountId: z.string().nullish(),
  modelId: z.string().nullish(),
});

const autoDraftBody = z.object({
  accountId: z.string().min(1),
  messageId: z.string().nullish(),
  prompt: z.string().optional(),
  recentMessageIds: z.array(z.string()).max(20).optional(),
  modelId: z.string().nullish(),
});

const replyBody = z.object({
  messageId: z.string().nullish(),
  userPrompt: z.string().optional(),
  accountId: z.string().nullish(),
  tone: z.enum(['professional', 'friendly', 'brief']).optional(),
  modelId: z.string().nullish(),
});

const classifyBody = z.object({
  messageId: z.string().min(1),
  modelId: z.string().nullish(),
});

const classifyBatchBody = z.object({
  messageIds: z.array(z.string()).min(1).max(50),
  modelId: z.string().nullish(),
});

const inboxSummaryBody = z
  .object({ accountId: z.string().nullish(), modelId: z.string().nullish() })
  .passthrough();

const smartRepliesBody = z.object({
  messageId: z.string().min(1),
  modelId: z.string().nullish(),
});

/** Map a service error to a JSON response; unknown errors become a 500. */
function handleError(c: AppContext, err: unknown) {
  if (err instanceof InsufficientAiCreditsError) {
    return c.json(
      {
        success: false,
        error: {
          code: 'insufficient_credits',
          message: 'Insufficient credits. Top up your workspace balance to continue.',
          details: {
            currentBalance: err.currentBalance,
            required: err.required,
            shortfall: err.shortfall,
          },
        },
      },
      402,
    );
  }
  if (err instanceof MailAiError) {
    const status = err.status ?? 500;
    const code = err.code === 'AI_NOT_CONFIGURED' ? 'ai_unavailable' : err.code.toLowerCase();
    return c.json({ success: false, error: { code, message: err.message } }, status as 400);
  }
  console.error('[mail-ai] unexpected error', err);
  return c.json(
    { success: false, error: { code: 'internal_error', message: 'AI request failed' } },
    500,
  );
}

/** Publish an `email` `updated` event after a classification write-back. */
function publishClassified(c: AppContext, r: ClassificationResult) {
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: r.messageId,
    action: 'updated',
    data: { id: r.messageId, accountId: r.accountId, subject: r.subject, from: null, to: null },
  });
}

app.post('/draft', requirePermission('messages:create'), zValidator('json', draftBody), async (c) => {
  try {
    const data = await draftEmail(c.env, c.get('tenantDb'), c.req.valid('json'), await metersFor(c));
    return c.json({ success: true, data });
  } catch (err) {
    return handleError(c, err);
  }
});

app.post(
  '/improve-text',
  requirePermission('messages:update'),
  zValidator('json', improveBody),
  async (c) => {
    try {
      const data = await improveText(c.env, c.get('tenantDb'), c.req.valid('json'), await metersFor(c));
      return c.json({ success: true, data });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

app.post(
  '/auto-draft',
  requirePermission('messages:create'),
  zValidator('json', autoDraftBody),
  async (c) => {
    try {
      const data = await autoDraft(c.env, c.get('tenantDb'), c.req.valid('json'), await metersFor(c));
      // Consumers (message-detail) read `result.draft.{subject,body}`.
      return c.json({ success: true, draft: data, data });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

app.post('/reply', requirePermission('messages:create'), zValidator('json', replyBody), async (c) => {
  try {
    const data = await replySuggestion(c.env, c.get('tenantDb'), c.req.valid('json'), await metersFor(c));
    // Consumers (compose panel, message-detail) read `result.body` (top-level).
    return c.json({ success: true, body: data.body, data });
  } catch (err) {
    return handleError(c, err);
  }
});

app.post(
  '/smart-replies',
  requirePermission('messages:create'),
  zValidator('json', smartRepliesBody),
  async (c) => {
    try {
      const data = await smartReplies(c.env, c.get('tenantDb'), c.req.valid('json'), await metersFor(c));
      return c.json({ success: true, data });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

app.post(
  '/inbox-summary',
  requirePermission('messages:read'),
  zValidator('json', inboxSummaryBody),
  async (c) => {
    try {
      const { accountId, modelId } = c.req.valid('json');
      const data = await inboxSummary(c.env, c.get('tenantDb'), { accountId, modelId }, await metersFor(c));
      return c.json({ success: true, data });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

app.post('/label', requirePermission('messages:update'), zValidator('json', classifyBody), async (c) => {
  try {
    const data = await classifyMessage(c.env, c.get('tenantDb'), c.req.valid('json'), await metersFor(c));
    publishClassified(c, data);
    return c.json({ success: true, data });
  } catch (err) {
    return handleError(c, err);
  }
});

app.post(
  '/label/batch',
  requirePermission('messages:update'),
  zValidator('json', classifyBatchBody),
  async (c) => {
    try {
      const results = await classifyMessagesBatch(
        c.env,
        c.get('tenantDb'),
        c.req.valid('json'),
        await metersFor(c),
      );
      for (const r of results) publishClassified(c, r);
      return c.json({ success: true, data: { results } });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

export const mailAiRoutes = app;

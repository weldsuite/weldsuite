/**
 * App-API mail-ai domain client — flat `/api/mail-ai/*`.
 *
 * Each endpoint returns the raw `Response` because the upstream
 * agent-worker may stream `text/event-stream`. Callers that want JSON
 * can call `.json()`; callers that want SSE can pipe `.body`.
 */

import type { ClientApi } from '../types';
import type {
  DraftMailAiInput,
  ImproveTextMailAiInput,
  AutoDraftMailAiInput,
  ReplyMailAiInput,
  ClassifyMailAiInput,
  ClassifyBatchMailAiInput,
  InboxSummaryMailAiInput,
  SmartRepliesMailAiInput,
} from '../schemas/mail-ai';

/**
 * The shared HTTP client returns parsed JSON; for streaming endpoints
 * we need the raw `Response`. The factory exposes a `raw` escape hatch
 * over the platform's fetch wrapper for these proxy calls.
 */
export interface MailAiRawClient {
  raw(path: string, init: RequestInit): Promise<Response>;
}

export function createMailAiApi(api: ClientApi & Partial<MailAiRawClient>) {
  const postRaw = async (path: string, body: unknown): Promise<Response> => {
    if (api.raw) {
      return api.raw(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    // Fallback: parse JSON via the standard client — loses streaming, but
    // returns a synthesised Response so callers don't have to branch.
    const json = await api.post<unknown>(path, body);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    draft(data: DraftMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/draft', data);
    },

    improveText(data: ImproveTextMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/improve-text', data);
    },

    autoDraft(data: AutoDraftMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/auto-draft', data);
    },

    reply(data: ReplyMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/reply', data);
    },

    classify(data: ClassifyMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/label', data);
    },

    classifyBatch(data: ClassifyBatchMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/label/batch', data);
    },

    inboxSummary(data: InboxSummaryMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/inbox-summary', data);
    },

    smartReplies(data: SmartRepliesMailAiInput): Promise<Response> {
      return postRaw('/mail-ai/smart-replies', data);
    },
  };
}

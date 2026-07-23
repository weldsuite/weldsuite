/**
 * App-API AI domain client — flat `/api/ai/*`.
 *
 * Backs the WeldAgent chat panel. Every call routes through the Cloudflare AI
 * Gateway server-side and is metered against the prepaid credit wallet. Non-
 * streaming JSON (the platform client has no streaming transport).
 */

import type { ClientApi, DataResponse } from '../types';
import type { AiChatInput, AiChatResult } from '../schemas/ai';

export function createAiApi(api: ClientApi) {
  return {
    /** Multi-turn WeldAgent chat. Send the full running conversation each turn. */
    chat(data: AiChatInput): Promise<DataResponse<AiChatResult>> {
      return api.post<DataResponse<AiChatResult>>('/ai/chat', data);
    },
  };
}

export type AiApi = ReturnType<typeof createAiApi>;

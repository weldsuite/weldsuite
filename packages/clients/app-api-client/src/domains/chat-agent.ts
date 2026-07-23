/**
 * App-API chat-agent domain client — `/api/chat-agent/*`.
 *
 * Mirrors apps/workers/app-api/src/routes/chat-agent/index.ts. `ask` proxies a
 * WeldAgent question for a chat channel; the answer is persisted as a bot
 * message and the channel preview/counters are bumped server-side.
 */

import type { ClientApi, DataResponse } from '../types';

export interface AskChatAgentInput {
  question: string;
  channelId: string;
}

export interface AskChatAgentResponse {
  questionMessageId: string;
  responseMessageId: string;
}

export function createChatAgentApi(api: ClientApi) {
  return {
    ask(body: AskChatAgentInput): Promise<DataResponse<AskChatAgentResponse>> {
      return api.post<DataResponse<AskChatAgentResponse>>('/chat-agent/ask', body);
    },
  };
}

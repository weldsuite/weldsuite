/**
 * Handler Registry — registers all inline step handlers including AI.
 */

import type { StepHandler } from '../types';
import { sendMessageHandler } from './send-message';
import { sendChoicesHandler } from './send-choices';
import { collectInputHandler } from './collect-input';
import { collectCustomerInfoHandler } from './collect-customer-info';
import { delayHandler } from './delay';
import { closeConversationHandler } from './close-conversation';
import { changeStatusHandler } from './change-status';
import { changePriorityHandler } from './change-priority';
import { assignConversationHandler } from './assign-conversation';
import { unassignConversationHandler } from './unassign-conversation';
import { tagConversationHandler } from './tag-conversation';
import { addInternalNoteHandler } from './add-internal-note';
import { suggestArticlesHandler } from './suggest-articles';
import { triggerCsatHandler } from './trigger-csat';
import { conditionHandler } from './condition';
import { aiAutoReplyHandler } from './ai-auto-reply';

const handlers = new Map<string, StepHandler>();

const allHandlers: StepHandler[] = [
  sendMessageHandler,
  sendChoicesHandler,
  collectInputHandler,
  collectCustomerInfoHandler,
  delayHandler,
  closeConversationHandler,
  changeStatusHandler,
  changePriorityHandler,
  assignConversationHandler,
  unassignConversationHandler,
  tagConversationHandler,
  addInternalNoteHandler,
  suggestArticlesHandler,
  triggerCsatHandler,
  conditionHandler,
  aiAutoReplyHandler,
];

for (const h of allHandlers) handlers.set(h.type, h);

// Alias
handlers.set('ai_agent', aiAutoReplyHandler);

export function getHandler(type: string): StepHandler | undefined {
  return handlers.get(type);
}

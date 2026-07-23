/**
 * Handler Registry Index
 *
 * Registers the 15 core step handlers for helpdesk workflows.
 * Import this file once to populate the registry.
 */

import { registerHandler } from '../registry';

// Customer-facing (6)
import { sendMessageHandler } from './send-message';
import { sendChoicesHandler } from './send-choices';
import { collectInputHandler } from './collect-input';
import { suggestArticlesHandler } from './suggest-articles';
import { addInternalNoteHandler } from './add-internal-note';
import { aiAutoReplyHandler } from './ai-auto-reply';

// Routing (2)
import { assignConversationHandler } from './assign-conversation';
import { unassignConversationHandler } from './unassign-conversation';

// Status (3)
import { closeConversationHandler } from './close-conversation';
import { changeStatusHandler } from './change-status';
import { changePriorityHandler } from './change-priority';

// Other (4)
import { tagConversationHandler } from './tag-conversation';
import { triggerCsatHandler } from './trigger-csat';
import { delayHandler } from './delay';
import { conditionHandler } from './condition';

// Register all handlers
const allHandlers = [
  // Customer-facing
  sendMessageHandler,
  sendChoicesHandler,
  collectInputHandler,
  suggestArticlesHandler,
  addInternalNoteHandler,
  aiAutoReplyHandler,
  // Routing
  assignConversationHandler,
  unassignConversationHandler,
  // Status
  closeConversationHandler,
  changeStatusHandler,
  changePriorityHandler,
  // Other
  tagConversationHandler,
  triggerCsatHandler,
  delayHandler,
  conditionHandler,
];

for (const handler of allHandlers) {
  registerHandler(handler);
}

// Also register ai_agent as alias for ai_auto_reply
registerHandler({ ...aiAutoReplyHandler, type: 'ai_agent' });

export { allHandlers };

/**
 * Company chat sub-route — mounted under /api/companies/:id/chat.
 *
 * Forwarded to chat-api's `company` record chat
 * (/api/chat-entity-channels/company/:id/*), see lib/record-chat-forward.ts.
 */

import { recordChatRoutes } from '../../lib/record-chat-forward';

export const companyChatRoutes = recordChatRoutes('company');

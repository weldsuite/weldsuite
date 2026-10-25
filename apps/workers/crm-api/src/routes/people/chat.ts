/**
 * Person chat sub-route — mounted under /api/people/:id/chat.
 *
 * Forwarded to chat-api's `person` record chat
 * (/api/chat-entity-channels/person/:id/*), see lib/record-chat-forward.ts.
 */

import { recordChatRoutes } from '../../lib/record-chat-forward';

export const personChatRoutes = recordChatRoutes('person');

/**
 * WeldKnow (knowledge base) entity events.
 *
 * `moved` fires when a page changes parent/space/position so tree consumers
 * (realtime sidebar, workflows) can react without diffing `updated` payloads.
 */
export const KNOWLEDGE_ENTITY_EVENTS = {
  knowledge_space: ['created', 'updated', 'deleted'],
  knowledge_page: ['created', 'updated', 'deleted', 'moved', 'restored'],
} as const;

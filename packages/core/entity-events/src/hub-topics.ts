/**
 * WorkspaceHub subscribe topics derived from the entity-events catalog.
 *
 * Member/viewer ACL in realtime-worker uses this list so new catalog entity
 * types are covered automatically. Underscore types (`project_task`,
 * `helpdesk_ticket`, …) must be listed explicitly — `canSubscribe` only
 * matches exact topics or `prefix.` children, never underscore suffixes.
 */

import { ENTITY_EVENTS } from './events';

/**
 * Bare prefixes that stay user-scoped on WorkspaceHub.
 * Callers add `notification.<userId>` (etc.); never the bare name.
 * Mirrors `PERSONAL_TOPIC_PREFIXES` in realtime-worker and
 * `BARE_PERSONAL_TOPICS` in `@weldsuite/realtime`.
 */
export const PERSONAL_HUB_TOPIC_PREFIXES = [
  'notification',
  'mail',
  'inbox',
  'chat.user',
] as const;

/**
 * Non-catalog hub topics every member/viewer may also subscribe to.
 * `presence` is published by the realtime worker, not the entity-event bus.
 */
export const EXTRA_MEMBER_HUB_TOPICS = ['presence'] as const;

const PERSONAL = new Set<string>(PERSONAL_HUB_TOPIC_PREFIXES);

/**
 * Catalog entity types members/viewers may subscribe to on WorkspaceHub.
 * Excludes bare personal prefixes (`notification` is in the catalog but
 * must remain user-scoped only).
 */
export function listMemberHubEntityTopics(): readonly string[] {
  return Object.keys(ENTITY_EVENTS).filter((topic) => !PERSONAL.has(topic));
}

/**
 * Full non-personal hub allow-list: catalog entity topics + extras (presence).
 */
export function listMemberHubTopics(): readonly string[] {
  return [...listMemberHubEntityTopics(), ...EXTRA_MEMBER_HUB_TOPICS];
}

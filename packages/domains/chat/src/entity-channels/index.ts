/**
 * Entity-linked chat channels ("record chats"): the provider registry.
 *
 * Lives in @weldsuite/chat-domain (moved from chat-api) so `canAccessChannel`
 * can ask the record's provider whether a user may read its chat, in every
 * worker that evaluates the WeldChat read boundary (chat-api, connect-api, …).
 *
 * Importing this module registers all known entity providers so that
 * `getEntityProvider(type)` returns the right one at runtime. New entity
 * types are added by creating a file under `./providers` that calls
 * `registerEntityProvider(...)` at import time, and adding an import here.
 *
 * Import order is the record chat group order: Companies, People, Tasks,
 * Projects, Domains. `contact` is a legacy name (see ./providers/contact.ts).
 */
import './providers/company';
import './providers/person';
import './providers/task';
import './providers/project';
import './providers/domain';
import './providers/contact';

export * from './registry';
export * from './permissions';

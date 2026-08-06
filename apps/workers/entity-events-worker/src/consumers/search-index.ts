/**
 * Semantic search indexing.
 *
 * The one consumer that does not run inline. Indexing costs an embedding call
 * per record, so it keeps its own isolate, its own concurrency ceiling and its
 * own dead-letter queue over in app-api — which is also where the loader
 * registry and AI gateway already live. The dispatcher just forwards.
 *
 * `subscribes: '*'` rather than a list of indexed types: app-api's consumer
 * already resolves whether a type is indexable (`resolveIndexedType`) and acks
 * anything that is not, and duplicating that list here would give two places to
 * forget to update.
 */

import { defineConsumer } from '@weldsuite/entity-events/consumers';
import type { Env } from '../env';

export const searchIndexConsumer = defineConsumer<Env>({
  name: 'search-index',
  subscribes: '*',
  transport: 'queue',
  queueBinding: 'SEARCH_EVENTS',
});

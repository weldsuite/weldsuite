/**
 * The consumer registry.
 *
 * This is the file you edit to add a consumer. Write the consumer next to this
 * one, import it, add it to the array — no queue to create, no wrangler block,
 * no producer change, no new worker.
 *
 *   import { auditConsumer } from './audit';
 *
 *   export const CONSUMERS: readonly EntityEventConsumer<Env>[] = [
 *     auditConsumer,
 *   ];
 *
 * `validateRegistry` runs at module load, so a duplicate name fails the deploy
 * rather than a request. Each consumer's own `defineConsumer` call has already
 * checked its subscriptions against the events catalog by this point.
 */

import { validateRegistry, type EntityEventConsumer } from '@weldsuite/entity-events/consumers';
import type { Env } from '../env';
import { auditConsumer } from './audit';
import { analyticsConsumer } from './analytics';
import { webhooksConsumer } from './webhooks';
import { workflowTriggersConsumer } from './workflow-triggers';
import { searchIndexConsumer } from './search-index';

export const CONSUMERS: readonly EntityEventConsumer<Env>[] = [
  auditConsumer,
  analyticsConsumer,
  webhooksConsumer,
  workflowTriggersConsumer,
  searchIndexConsumer,
];

validateRegistry(CONSUMERS);

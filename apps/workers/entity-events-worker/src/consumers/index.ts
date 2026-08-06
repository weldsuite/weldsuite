/**
 * The consumer registry.
 *
 * This is the file you edit to add a consumer. Write the consumer next to this
 * one, import it, add it to the array — no queue to create, no wrangler block,
 * no producer change, no new worker.
 *
 *   import { auditConsumer } from './audit';
 *
 *   export const CONSUMERS = [
 *     auditConsumer,
 *   ] as const satisfies readonly EntityEventConsumer<Env>[];
 *
 * Empty on purpose. Phase 1 runs the dispatcher on shadow traffic so the
 * volume and shape can be watched before anything depends on it; phase 2
 * migrates the existing sinks here one per PR. See
 * `.claude/entity-events-plan.md`.
 *
 * `validateRegistry` runs at module load, so a duplicate name fails the deploy
 * rather than a request. Each consumer's own `defineConsumer` call has already
 * checked its subscriptions against the events catalog by this point.
 */

import { validateRegistry, type EntityEventConsumer } from '@weldsuite/entity-events/consumers';
import type { Env } from '../env';

export const CONSUMERS: readonly EntityEventConsumer<Env>[] = [];

validateRegistry(CONSUMERS);

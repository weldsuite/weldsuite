/**
 * Fixtures for the pglite-backed send-engine and route tests: the shared
 * seeders (in the domain package) and the Env-typed test environment.
 */

import { queueSpy, TEST_ENCRYPTION_KEY, type QueueSpy } from '@weldsuite/reach-domain/testing/reach';
import type { Env } from '../types';

export * from '@weldsuite/reach-domain/testing/reach';

export function testEnv(overrides: Partial<Env> = {}): Env & { events: QueueSpy<unknown> } {
  const events = queueSpy<unknown>();
  return {
    ENVIRONMENT: 'test',
    DATABASE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ENTITY_EVENTS: events as unknown as Env['ENTITY_EVENTS'],
    events,
    ...overrides,
  } as unknown as Env & { events: QueueSpy<unknown> };
}

/**
 * Resolve a workspace member's effective permissions outside a request (queue
 * consumers, the durable job workflow), for narrowing an agent's grants to the
 * human it acts for. Same resolver as the request-time permission middleware.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  createDrizzlePermissionQueries,
  resolveEffectivePermissions,
} from '@weldsuite/permissions/server';
import { schema } from '../../db';
import type { AgentDb } from './agents';

/** Effective permissions of `userId`; empty for unknown / system actors. */
export async function resolveActorPermissions(db: AgentDb, userId: string | null | undefined): Promise<string[]> {
  if (!userId || userId === 'system') return [];
  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  return (await resolveEffectivePermissions(queries, userId)).permissions;
}

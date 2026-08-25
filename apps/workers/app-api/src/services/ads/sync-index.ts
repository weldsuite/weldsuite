import { and, eq } from 'drizzle-orm';
import { getMasterDb } from '../../db';
import * as masterSchema from '@weldsuite/db/schema/master';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';

const { adSyncIndex } = masterSchema;

export interface UpsertAdSyncIndexInput {
  workspaceId: string;
  connectionId: string;
  clerkOrgId: string;
  isEnabled: boolean;
  metricsIntervalHours?: number;
  webhookSubscribedAt?: Date | null;
}

export async function upsertAdSyncIndex(env: Env, input: UpsertAdSyncIndexInput): Promise<void> {
  const masterDb = getMasterDb(env);
  const now = new Date();
  const nextMetricsSyncAt = input.isEnabled
    ? new Date(now.getTime() + (input.metricsIntervalHours ?? 6) * 60 * 60 * 1000)
    : null;

  const [existing] = await masterDb
    .select({ id: adSyncIndex.id })
    .from(adSyncIndex)
    .where(
      and(
        eq(adSyncIndex.workspaceId, input.workspaceId),
        eq(adSyncIndex.connectionId, input.connectionId),
      ),
    )
    .limit(1);

  if (existing) {
    await masterDb
      .update(adSyncIndex)
      .set({
        clerkOrgId: input.clerkOrgId,
        isEnabled: input.isEnabled,
        metricsIntervalHours: input.metricsIntervalHours ?? 6,
        nextMetricsSyncAt,
        webhookSubscribedAt: input.webhookSubscribedAt ?? undefined,
        updatedAt: now,
      })
      .where(eq(adSyncIndex.id, existing.id));
    return;
  }

  await masterDb.insert(adSyncIndex).values({
    id: generateId('adsx'),
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    clerkOrgId: input.clerkOrgId,
    isEnabled: input.isEnabled,
    metricsIntervalHours: input.metricsIntervalHours ?? 6,
    nextMetricsSyncAt,
    webhookSubscribedAt: input.webhookSubscribedAt ?? null,
    updatedAt: now,
  });
}

export async function deleteAdSyncIndex(
  env: Env,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  const masterDb = getMasterDb(env);
  await masterDb
    .delete(adSyncIndex)
    .where(
      and(eq(adSyncIndex.workspaceId, workspaceId), eq(adSyncIndex.connectionId, connectionId)),
    );
}

export async function touchAdSyncIndexAfterMetricsSync(
  env: Env,
  workspaceId: string,
  connectionId: string,
  metricsIntervalHours = 6,
): Promise<void> {
  const masterDb = getMasterDb(env);
  const now = new Date();
  await masterDb
    .update(adSyncIndex)
    .set({
      nextMetricsSyncAt: new Date(now.getTime() + metricsIntervalHours * 60 * 60 * 1000),
      updatedAt: now,
    })
    .where(
      and(eq(adSyncIndex.workspaceId, workspaceId), eq(adSyncIndex.connectionId, connectionId)),
    );
}

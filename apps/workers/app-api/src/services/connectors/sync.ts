/**
 * First-party connector sync runner.
 *
 * Pulls pages from the provider, ingests them, and writes a sync-run row.
 * Page ceiling keeps a Worker invocation bounded; an unfinished run leaves the
 * watermark put so the next pass re-reads (checksums skip unchanged records).
 *
 * Ongoing updates do not use this runner — stores push via webhooks. This is
 * for the initial backfill and an explicit "Sync now".
 */

import {
  ConnectorApiError,
  enabledConnectorSyncs,
  getConnector,
} from '@weldsuite/connectors';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { ingestRecords, type IngestCounts } from './ingest';
import { modifiedAtOf } from './mappers';
import { createConnectorClient, storeUrlOf } from './clients';
import {
  decryptCredentials,
  finishSyncRun,
  keyringFromEnv,
  markConnectionError,
  startSyncRun,
  type ConnectorConnectionRow,
} from './connections';

const MAX_PAGES = 10;
const PER_PAGE = 100;

export interface SyncConnectionArgs {
  db: Database;
  env: Env;
  connection: ConnectorConnectionRow;
  ownerId: string;
  workspaceId: string;
  trigger: 'manual' | 'initial' | 'schedule' | 'webhook';
  full?: boolean;
  /** Restrict to these setting keys / sync names. Empty = whatever the connection has enabled. */
  syncs?: string[];
}

function emptyCounts(): IngestCounts {
  return { created: 0, modified: 0, skipped: 0, deleted: 0, failed: 0 };
}

function addCounts(a: IngestCounts, b: IngestCounts): IngestCounts {
  return {
    created: a.created + b.created,
    modified: a.modified + b.modified,
    skipped: a.skipped + b.skipped,
    deleted: a.deleted + b.deleted,
    failed: a.failed + b.failed,
  };
}

function latestModified(records: Array<Record<string, unknown>>): string | null {
  let latest: string | null = null;
  for (const record of records) {
    const at = modifiedAtOf(record);
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}

export async function syncConnection(args: SyncConnectionArgs): Promise<{ triggered: string[] }> {
  const connector = getConnector(args.connection.provider);
  if (!connector) {
    throw new ConnectorApiError({ message: `Unknown connector '${args.connection.provider}'`, status: 400, kind: 'permanent' });
  }

  let requested = args.syncs?.length
    ? [...args.syncs]
    : [...(args.connection.enabledSyncs ?? [])];
  // Mutations need account mappings. If transactions are enabled but accounts are not,
  // still pull accounts first so statement lines can attach to a bank account.
  const wantsBankTx = requested.some(
    (key) => key === 'bankTransactions' || key === 'moneybird-financial-mutations',
  );
  const hasBankAccounts = requested.some(
    (key) => key === 'bankAccounts' || key === 'moneybird-financial-accounts',
  );
  if (wantsBankTx && !hasBankAccounts && connector.provider === 'moneybird') {
    requested = ['bankAccounts', ...requested];
  }
  const syncs = enabledConnectorSyncs(connector, requested);
  if (syncs.length === 0) return { triggered: [] };

  const keyring = keyringFromEnv(args.env);
  const credentials = await decryptCredentials(args.connection.credentials ?? undefined, keyring);
  const client = createConnectorClient(
    args.connection.provider,
    credentials,
    args.connection.externalAccountId,
  );

  for (const sync of syncs) {
    const runId = await startSyncRun({
      db: args.db,
      connectionId: args.connection.id,
      syncName: sync.syncName,
      model: sync.model,
      trigger: args.trigger === 'webhook' ? 'webhook' : args.trigger,
      syncType: args.full ? 'FULL' : args.connection.syncWatermarks?.[sync.model] ? 'INCREMENTAL' : 'INITIAL',
    });

    const modifiedAfter = args.full ? undefined : args.connection.syncWatermarks?.[sync.model];
    let page = 1;
    let cursor: string | null = null;
    let truncated = false;
    let lastWatermark: string | null = modifiedAfter ?? null;
    const applied = emptyCounts();
    const errorSamples: Array<{ externalId: string; message: string }> = [];

    try {
      while (page <= MAX_PAGES) {
        const result = await client.listSync(sync, {
          page,
          cursor,
          limit: PER_PAGE,
          modifiedAfter,
        });
        if (result.items.length === 0) break;

        const ingested = await ingestRecords({
          db: args.db,
          connectionId: args.connection.id,
          provider: args.connection.provider,
          displayName: args.connection.displayName,
          storeUrl: storeUrlOf(client),
          sync,
          records: result.items,
          ownerId: args.ownerId,
          workspaceId: args.workspaceId,
          entityId: credentials.entityId?.trim() || null,
          env: args.env as unknown as Record<string, unknown>,
        });
        Object.assign(applied, addCounts(applied, ingested));
        errorSamples.push(...ingested.errorSamples.slice(0, 5 - errorSamples.length));

        const pageWatermark = latestModified(result.items);
        if (pageWatermark) lastWatermark = pageWatermark;

        if (result.done) break;
        if (page === MAX_PAGES) {
          truncated = true;
          break;
        }
        page += 1;
        cursor = result.nextCursor;
      }

      const failed = applied.failed > 0;
      const status = failed || truncated ? 'partial' : 'success';
      await finishSyncRun({
        db: args.db,
        runId,
        connectionId: args.connection.id,
        status,
        applied,
        error: failed ? `${applied.failed} record(s) failed to import` : truncated ? 'Page ceiling reached — run again to continue' : null,
        errorSamples,
        watermark: lastWatermark ? { model: sync.model, at: lastWatermark } : null,
      });
    } catch (err) {
      const auth = err instanceof ConnectorApiError && err.kind === 'auth';
      const message = err instanceof Error ? err.message : 'Sync failed';
      if (auth) {
        await markConnectionError({
          db: args.db,
          connectionId: args.connection.id,
          status: 'auth_error',
          message,
        });
      }
      await finishSyncRun({
        db: args.db,
        runId,
        connectionId: args.connection.id,
        status: 'error',
        applied,
        error: message,
        errorSamples,
      });
      if (auth) throw err;
    }
  }

  return { triggered: syncs.map((s) => s.syncName) };
}

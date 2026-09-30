/**
 * First-party connector sync runner.
 *
 * Pulls pages from the provider, ingests them, and writes a sync-run row.
 * Page ceiling keeps a Worker invocation bounded; a truncated run persists a
 * `${model}__page` (and optional `${model}__cursor`) watermark so the next
 * pass continues. The modified-at watermark advances only when a full scan
 * finishes successfully.
 *
 * Ongoing updates do not use this runner — stores push via webhooks. This is
 * for the initial backfill and an explicit "Sync now".
 */

import {
  ConnectorApiError,
  allowsInboundSync,
  enabledConnectorSyncs,
  getConnector,
  MoneybirdClient,
  resolveConnectorObjectDirection,
} from '@weldsuite/connectors';
import type { Database } from '@weldsuite/worker-kit/db';
import type { DbEnv } from '@weldsuite/worker-kit/env';
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
import {
  MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET,
  type MoneybirdAttachmentSyncContext,
} from './moneybird-attachments';

/**
 * What the sync runner reads: the credential keyring and the R2 bucket
 * Moneybird attachments are copied into (skipped without it). The env is
 * also handed on to entity-event publishing during ingest.
 */
export type ConnectorSyncEnv = Pick<DbEnv, 'DATABASE_ENCRYPTION_KEY' | 'DATABASE_ENCRYPTION_KEY_V2'> & {
  STORAGE?: R2Bucket;
};

const MAX_PAGES = 10;
const PER_PAGE = 100;

function moneybirdAttachmentContext(
  env: ConnectorSyncEnv,
  client: ReturnType<typeof createConnectorClient>,
  workspaceId: string,
  budget: { remaining: number },
): MoneybirdAttachmentSyncContext | null {
  if (!(client instanceof MoneybirdClient) || !env.STORAGE) return null;
  return {
    client,
    storage: env.STORAGE,
    workspaceId,
    budget,
  };
}

export interface SyncConnectionArgs {
  db: Database;
  env: ConnectorSyncEnv;
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

function pageWatermarkKey(model: string): string {
  return `${model}__page`;
}

function cursorWatermarkKey(model: string): string {
  return `${model}__cursor`;
}

type SyncConnector = NonNullable<ReturnType<typeof getConnector>>;
type SyncDefinition = SyncConnector['syncs'][number];
type SyncClient = ReturnType<typeof createConnectorClient>;

/** Setting keys / sync names to run, plus the bank-account dependency for Moneybird. */
function requestedSyncKeys(connector: SyncConnector, args: SyncConnectionArgs): string[] {
  const requested = args.syncs?.length
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
    return ['bankAccounts', ...requested];
  }
  return requested;
}

function syncTypeFor(
  args: SyncConnectionArgs,
  continuing: boolean,
  model: string,
): 'FULL' | 'INITIAL' | 'INCREMENTAL' {
  if (args.full) return 'FULL';
  if (continuing) return 'INITIAL';
  return args.connection.syncWatermarks?.[model] ? 'INCREMENTAL' : 'INITIAL';
}

interface SyncPullContext {
  args: SyncConnectionArgs;
  client: SyncClient;
  credentials: Record<string, string>;
  moneybirdAttachments: MoneybirdAttachmentSyncContext | null;
  sync: SyncDefinition;
}

interface SyncPullState {
  page: number;
  cursor: string | null;
  truncated: boolean;
  done: boolean;
  pagesFetched: number;
  lastWatermark: string | null;
  applied: IngestCounts;
  errorSamples: Array<{ externalId: string; message: string }>;
}

/** Fetches + ingests pages until the scan is done or the page ceiling is hit. Mutates `state`. */
async function pullPages(
  ctx: SyncPullContext,
  state: SyncPullState,
  modifiedAfter: string | undefined,
): Promise<void> {
  const { args, client, credentials, moneybirdAttachments, sync } = ctx;
  while (state.pagesFetched < MAX_PAGES) {
    const result = await client.listSync(sync, {
      page: state.page,
      cursor: state.cursor,
      limit: PER_PAGE,
      modifiedAfter,
    });
    state.pagesFetched += 1;
    if (result.items.length === 0) {
      state.done = true;
      return;
    }

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
      moneybirdAttachments,
    });
    Object.assign(state.applied, addCounts(state.applied, ingested));
    state.errorSamples.push(...ingested.errorSamples.slice(0, 5 - state.errorSamples.length));

    const pageWatermark = latestModified(result.items);
    if (pageWatermark) state.lastWatermark = pageWatermark;

    if (result.done) {
      state.done = true;
      return;
    }
    state.page += 1;
    state.cursor = result.nextCursor;
    if (state.pagesFetched === MAX_PAGES) {
      state.truncated = true;
      return;
    }
  }
}

function buildWatermarkPatch(
  model: string,
  state: SyncPullState,
  continuing: boolean,
): Record<string, string | null> {
  const pageKey = pageWatermarkKey(model);
  const cursorKey = cursorWatermarkKey(model);
  const patch: Record<string, string | null> = {};
  if (state.truncated) {
    // Persist continuation; do not advance the modified-at watermark yet.
    patch[pageKey] = String(state.page);
    patch[cursorKey] = state.cursor;
  } else if (state.done || !continuing) {
    patch[pageKey] = null;
    patch[cursorKey] = null;
    if (state.applied.failed === 0 && state.lastWatermark) {
      patch[model] = state.lastWatermark;
    }
  }
  return patch;
}

function syncRunError(state: SyncPullState): string | null {
  if (state.applied.failed > 0) return `${state.applied.failed} record(s) failed to import`;
  if (state.truncated) return 'Page ceiling reached — run again to continue';
  return null;
}

/** Records a failed run; re-throws auth failures so the caller stops the whole sync. */
async function recordSyncFailure(
  args: SyncConnectionArgs,
  runId: string,
  state: SyncPullState,
  err: unknown,
): Promise<void> {
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
    applied: state.applied,
    error: message,
    errorSamples: state.errorSamples,
  });
  if (auth) throw err;
}

async function runSingleSync(ctx: SyncPullContext): Promise<void> {
  const { args, sync } = ctx;
  const watermarks = args.connection.syncWatermarks;
  const savedPage = args.full ? undefined : watermarks?.[pageWatermarkKey(sync.model)];
  const continuing = Boolean(savedPage);
  const runId = await startSyncRun({
    db: args.db,
    connectionId: args.connection.id,
    syncName: sync.syncName,
    model: sync.model,
    trigger: args.trigger,
    syncType: syncTypeFor(args, continuing, sync.model),
  });

  // While a page cursor is open, ignore modifiedAfter so we finish the full scan.
  const modifiedAfter = args.full || continuing ? undefined : watermarks?.[sync.model];
  const state: SyncPullState = {
    page: continuing ? Math.max(1, Number(savedPage) || 1) : 1,
    cursor: continuing ? (watermarks?.[cursorWatermarkKey(sync.model)] ?? null) : null,
    truncated: false,
    done: false,
    pagesFetched: 0,
    lastWatermark: modifiedAfter ?? null,
    applied: emptyCounts(),
    errorSamples: [],
  };

  try {
    await pullPages(ctx, state, modifiedAfter);
    await finishSyncRun({
      db: args.db,
      runId,
      connectionId: args.connection.id,
      status: state.applied.failed > 0 || state.truncated ? 'partial' : 'success',
      applied: state.applied,
      error: syncRunError(state),
      errorSamples: state.errorSamples,
      syncWatermarksPatch: buildWatermarkPatch(sync.model, state, continuing),
    });
  } catch (err) {
    await recordSyncFailure(args, runId, state, err);
  }
}

export async function syncConnection(args: SyncConnectionArgs): Promise<{ triggered: string[] }> {
  const connector = getConnector(args.connection.provider);
  if (!connector) {
    throw new ConnectorApiError({ message: `Unknown connector '${args.connection.provider}'`, status: 400, kind: 'permanent' });
  }

  const syncs = enabledConnectorSyncs(connector, requestedSyncKeys(connector, args)).filter((sync) => {
    const direction = resolveConnectorObjectDirection({
      direction: args.connection.direction,
      objectSyncDirections: args.connection.objectSyncDirections,
      settingKey: sync.settingKey,
    });
    return allowsInboundSync(direction);
  });
  if (syncs.length === 0) return { triggered: [] };

  const keyring = keyringFromEnv(args.env);
  const credentials = await decryptCredentials(args.connection.credentials ?? undefined, keyring);
  const client = createConnectorClient(
    args.connection.provider,
    credentials,
    args.connection.externalAccountId,
  );
  const attachmentBudget = { remaining: MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET };
  const moneybirdAttachments = moneybirdAttachmentContext(
    args.env,
    client,
    args.workspaceId,
    attachmentBudget,
  );

  for (const sync of syncs) {
    await runSingleSync({ args, client, credentials, moneybirdAttachments, sync });
  }

  return { triggered: syncs.map((s) => s.syncName) };
}

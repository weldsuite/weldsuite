/**
 * Moneybird connector driver.
 *
 * Everything in the Moneybird API hangs off an administration
 * (`/api/v2/{administration_id}/…`), which is why `fetchAccountIdentity` runs as
 * part of completing the connect flow rather than lazily — without it the very
 * first list call has nowhere to go. The id lands on
 * `connector_connections.external_account_id`.
 *
 * **Polling only, deliberately.** Moneybird does support webhooks, and each
 * registered webhook carries a token and a secret described as being used for
 * signatures — but the signature algorithm and header name are not documented
 * anywhere we could verify. Implementing a guessed HMAC would mean one of two
 * failures: rejecting every legitimate delivery, or accepting forged ones. An
 * unverified webhook endpoint is worse than no webhook endpoint here, because
 * anyone who learned the URL could inject invoices into a tenant's books. So
 * this driver declares no webhook members and the scheduler sweeps it instead.
 * Confirm the scheme against a real delivery, then add
 * `verifyWebhookSignature` / `parseWebhookPayload` / `registerWebhooks`.
 *
 * @see https://developer.moneybird.com/authentication/
 * @see https://developer.moneybird.com/api/contacts/
 */

import {
  connectorFetch,
  ConnectorApiError,
  type ConnectorDriver,
  type DriverContext,
  type ExternalEntity,
  type FetchPageResult,
  type OAuth2Config,
  type SyncEntityType,
} from '@weldsuite/connectors';

const API_BASE = 'https://moneybird.com/api/v2';

/** Moneybird's documented ceiling. Asking for more is rejected, not clamped. */
const PER_PAGE = 100;

const OAUTH: OAuth2Config = {
  authorizeUrl: 'https://moneybird.com/oauth/authorize',
  tokenUrl: 'https://moneybird.com/oauth/token',
};

/** WeldSuite entity → Moneybird REST collection. */
const RESOURCE_BY_ENTITY: Partial<Record<SyncEntityType, string>> = {
  customer: 'contacts',
  invoice: 'sales_invoices',
};

interface MoneybirdAdministration {
  id: string;
  name?: string;
}

interface MoneybirdRecord {
  id: string;
  updated_at?: string;
  created_at?: string;
  [key: string]: unknown;
}

function resourceFor(entityType: SyncEntityType): string {
  const resource = RESOURCE_BY_ENTITY[entityType];
  if (!resource) {
    throw new ConnectorApiError({
      message: `Moneybird driver does not support entity type ${entityType}`,
      status: 400,
      kind: 'permanent',
      connectorId: 'moneybird',
    });
  }
  return resource;
}

function requireAdministrationId(ctx: DriverContext): string {
  if (!ctx.externalAccountId) {
    throw new ConnectorApiError({
      message: 'Moneybird connection has no administration id — reconnect to resolve it',
      status: 400,
      kind: 'permanent',
      connectorId: 'moneybird',
    });
  }
  return ctx.externalAccountId;
}

/**
 * Page numbers are the cursor.
 *
 * Moneybird paginates by `page` + `per_page` with no opaque cursor, so the
 * cursor the sync loop persists is just the next page number as a string.
 * Parsing defensively because a stored cursor outlives the code that wrote it.
 */
function parsePage(cursor: string | undefined): number {
  if (!cursor) return 1;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function toExternalEntity(entityType: SyncEntityType, record: MoneybirdRecord): ExternalEntity {
  return {
    id: String(record.id),
    type: entityType,
    data: record,
    // Fall back to created_at, then epoch. Never `now` — using the wall clock
    // would advance the watermark past records Moneybird has not sent yet.
    updatedAt: record.updated_at ?? record.created_at ?? new Date(0).toISOString(),
    raw: record,
  };
}

export class MoneybirdDriver implements ConnectorDriver {
  readonly connectorId = 'moneybird';
  readonly supportedEntities: readonly SyncEntityType[] = ['customer', 'invoice'];
  readonly authModes: readonly ('oauth2' | 'api_token')[] = ['oauth2', 'api_token'];
  readonly oauth2 = OAUTH;

  /**
   * Resolve which administration this token can reach.
   *
   * A token may grant access to several; we take the first and record it. A
   * tenant with multiple administrations therefore connects the first one, and
   * choosing between them is a follow-up rather than a silent wrong guess —
   * `settings.administrationId` overrides when set.
   */
  async fetchAccountIdentity(
    ctx: Omit<DriverContext, 'externalAccountId'>,
  ): Promise<{ externalAccountId: string; displayName?: string }> {
    const administrations = await connectorFetch<MoneybirdAdministration[]>({
      url: `${API_BASE}/administrations`,
      token: ctx.accessToken,
      connectorId: this.connectorId,
    });

    const preferred = ctx.settings?.administrationId;
    const chosen =
      (typeof preferred === 'string' ? administrations?.find((a) => a.id === preferred) : undefined) ??
      administrations?.[0];

    if (!chosen) {
      throw new ConnectorApiError({
        message: 'Moneybird token grants access to no administrations',
        status: 403,
        kind: 'auth',
        connectorId: this.connectorId,
      });
    }

    return { externalAccountId: String(chosen.id), displayName: chosen.name };
  }

  async fetchEntities(
    ctx: DriverContext,
    entityType: SyncEntityType,
    cursor?: string,
    updatedSince?: Date,
  ): Promise<FetchPageResult> {
    const administrationId = requireAdministrationId(ctx);
    const resource = resourceFor(entityType);
    const page = parsePage(cursor);

    const records = await connectorFetch<MoneybirdRecord[]>({
      url: `${API_BASE}/${administrationId}/${resource}`,
      token: ctx.accessToken,
      query: {
        page,
        per_page: PER_PAGE,
        // Moneybird filters are `key:value` pairs, comma separated, and
        // `updated_after` is exclusive and compared in UTC.
        filter: updatedSince ? `updated_after:${updatedSince.toISOString()}` : undefined,
      },
      connectorId: this.connectorId,
    });

    const list = Array.isArray(records) ? records : [];
    // A short page is the last page — Moneybird sends no total or next link.
    const hasMore = list.length === PER_PAGE;

    return {
      entities: list.map((record) => toExternalEntity(entityType, record)),
      nextCursor: hasMore ? String(page + 1) : undefined,
      hasMore,
    };
  }

  async fetchEntity(
    ctx: DriverContext,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<ExternalEntity> {
    const administrationId = requireAdministrationId(ctx);
    const resource = resourceFor(entityType);

    const record = await connectorFetch<MoneybirdRecord>({
      url: `${API_BASE}/${administrationId}/${resource}/${encodeURIComponent(externalId)}`,
      token: ctx.accessToken,
      connectorId: this.connectorId,
    });

    return toExternalEntity(entityType, record);
  }
}

export const moneybirdDriver = new MoneybirdDriver();

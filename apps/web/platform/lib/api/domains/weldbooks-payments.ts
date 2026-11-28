/**
 * WeldBooks online payments client (phase 4b, Rust only: edition feature
 * `books-online-payments`): the entity's own Mollie connection
 * (`/api/accounting-payment-connections`). Shapes mirror
 * `rust/modules/books-sales/src/online_payments/*`. Success answers `{ data }`,
 * errors `{ error: { code, message } }`.
 *
 * Connecting (Mollie Connect or an API key) and disconnecting need a second
 * factor; `weldbooksApi` asks for it (step-up) and sends the call once more.
 */
import { weldbooksApi } from '../weldbooks-client';

const BASE = '/accounting-payment-connections';

export type PaymentConnectionStatus = 'active' | 'needs_reauth' | 'disconnected' | 'error' | (string & {});
export type PaymentAuthMethod = 'oauth' | 'api_key';

/** The entity's payment connection as the settings card reads it. */
export interface PaymentConnection {
  id: string;
  provider: 'mollie';
  status: PaymentConnectionStatus;
  authMethod: PaymentAuthMethod;
  profileId: string | null;
  profileName: string | null;
  organizationName: string | null;
  testmode: boolean;
  /** The Mollie method ids customers may pay with (`ideal`, `bancontact`, ...). */
  methods: string[];
  connectedAt: string | null;
  /** Payouts and fees can only be read from a connection made through Mollie Connect. */
  settlementsAvailable: boolean;
  settlementsSyncedAt: string | null;
  /** The "Mollie" money account (a bank account of type `payment_provider`). */
  bankAccountId: string | null;
  lastError: string | null;
}

export interface MollieMethod {
  id: string;
  description: string;
}

export interface SettlementSyncResult {
  imported: number;
  skipped: number;
  lines: number;
  booked: number;
  toProcess: number;
  fees: number;
  payouts: number;
}

interface DataEnvelope<T> {
  data: T;
}

/** The error code of a refused call (`MOLLIE_CONNECT_NOT_CONFIGURED`, `SETTLEMENTS_UNAVAILABLE`, ...), or null. */
export function paymentErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : null;
}

/** The HTTP status of a refused call, or null. */
export function paymentErrorStatus(error: unknown): number | null {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : null;
  return typeof status === 'number' ? status : null;
}

export const paymentsApi = {
  /** `null` when the entity has no connection. */
  getConnection: () => weldbooksApi.get<DataEnvelope<PaymentConnection | null>>(BASE),
  /** Starts Mollie Connect: redirect the browser to `authorizeUrl`. */
  authorizeMollie: (returnUrl: string) =>
    weldbooksApi.post<DataEnvelope<{ authorizeUrl: string }>>(`${BASE}/mollie/authorize`, { returnUrl }),
  connectWithApiKey: (input: { apiKey: string; profileId?: string }) =>
    weldbooksApi.post<DataEnvelope<PaymentConnection>>(`${BASE}/mollie/api-key`, input),
  updateConnection: (id: string, patch: { methods?: string[] }) =>
    weldbooksApi.patch<DataEnvelope<PaymentConnection>>(`${BASE}/${encodeURIComponent(id)}`, patch),
  listMethods: (id: string) => weldbooksApi.get<DataEnvelope<MollieMethod[]>>(`${BASE}/${encodeURIComponent(id)}/methods`),
  disconnect: (id: string) => weldbooksApi.delete<void>(`${BASE}/${encodeURIComponent(id)}`),
  syncSettlements: (id: string) =>
    weldbooksApi.post<DataEnvelope<SettlementSyncResult>>(`${BASE}/${encodeURIComponent(id)}/sync-settlements`),
};

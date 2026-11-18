/**
 * Cloudflare for SaaS custom hostnames: a customer's own host name
 * (`stats.example.com`) served by one of our zones, the "SaaS zone", whose
 * fallback origin is the worker behind it. WeldPanel uses it so a site can
 * send analytics to a host of its own (panel-api's custom collector domains).
 *
 * The customer adds a CNAME from their host name to the zone's CNAME target;
 * the certificate is validated over HTTP once that CNAME is in place (so it
 * also renews on its own), and the ownership TXT record Cloudflare returns can
 * be added up front to activate the host name before the CNAME moves.
 *
 * Through the official SDK (`cloudflare/tree-shakable`, custom hostnames
 * resource only), never `new Cloudflare()`. Tests intercept the transport with
 * `__setZonesFetchForTests` from the package root.
 */

import { createClient } from 'cloudflare/tree-shakable';
import { APIError } from 'cloudflare/core/error';
import { BaseCustomHostnames, type CustomHostname } from 'cloudflare/resources/custom-hostnames/custom-hostnames';
import { getZonesTransport } from './transport';

export class CloudflareHostnameError extends Error {
  constructor(
    public readonly kind: 'AUTH_FAILED' | 'HOSTNAME_TAKEN' | 'INVALID_HOSTNAME' | 'UNKNOWN',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudflareHostnameError';
  }
}

function client(apiToken: string) {
  const fetch = getZonesTransport();
  return createClient({
    apiToken,
    maxRetries: 2,
    timeout: 15_000,
    ...(fetch ? { fetch } : {}),
    resources: [BaseCustomHostnames],
  });
}

function toHostnameError(err: unknown): CloudflareHostnameError {
  if (!(err instanceof APIError)) {
    return new CloudflareHostnameError('UNKNOWN', err instanceof Error ? err.message : 'Cloudflare request failed');
  }
  const errors = (err.errors ?? []).map((e) => ({ code: Number(e.code ?? 0), message: String(e.message ?? '') }));
  const first = errors[0]?.message;
  if (err.status === 401 || err.status === 403) {
    return new CloudflareHostnameError('AUTH_FAILED', 'Cloudflare API token is missing or lacks the SSL and Certificates scope', err.status);
  }
  // 1406: duplicate custom hostname; 1414: already in use elsewhere.
  if (errors.some((e) => e.code === 1406 || e.code === 1414) || err.status === 409) {
    return new CloudflareHostnameError('HOSTNAME_TAKEN', first ?? 'This host name is already in use', err.status);
  }
  if (err.status === 400 || err.status === 422) {
    return new CloudflareHostnameError('INVALID_HOSTNAME', first ?? 'Cloudflare refused this host name', err.status);
  }
  return new CloudflareHostnameError('UNKNOWN', `Cloudflare API error ${err.status ?? '(no status)'}: ${first ?? err.message}`, err.status);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHostnameError(err);
  }
}

/** A TXT record the customer may add (ownership pre-validation or certificate validation). */
export interface HostnameTxtRecord {
  name: string;
  value: string;
}

/** What WeldSuite needs of a custom hostname. */
export interface CustomHostnameState {
  id: string;
  hostname: string;
  /** Cloudflare's host name status (`pending`, `active`, `moved`, `blocked`, …). */
  status: string;
  /** The certificate's status (`pending_validation`, `active`, `validation_timed_out`, …). */
  sslStatus: string | null;
  /** Add this TXT record to activate the host name before its CNAME points at us. */
  ownership: HostnameTxtRecord | null;
  /** TXT records for certificate validation, when Cloudflare asks for any. */
  certificateRecords: HostnameTxtRecord[];
  /** Why validation failed, as Cloudflare says it. */
  errors: string[];
}

type HostnameLike = Pick<CustomHostname, 'id' | 'hostname' | 'status' | 'ssl' | 'ownership_verification' | 'verification_errors'>;

export function toCustomHostnameState(raw: HostnameLike): CustomHostnameState {
  const ownership = raw.ownership_verification;
  const certificateRecords = (raw.ssl?.validation_records ?? [])
    .filter((r): r is typeof r & { txt_name: string; txt_value: string } => Boolean(r.txt_name && r.txt_value))
    .map((r) => ({ name: r.txt_name, value: r.txt_value }));
  const errors = [
    ...(raw.verification_errors ?? []),
    ...(raw.ssl?.validation_errors ?? []).map((e) => e.message ?? '').filter(Boolean),
  ];
  return {
    id: raw.id,
    hostname: raw.hostname,
    status: raw.status ?? 'pending',
    sslStatus: raw.ssl?.status ?? null,
    ownership: ownership?.name && ownership.value ? { name: ownership.name, value: ownership.value } : null,
    certificateRecords,
    errors,
  };
}

/**
 * Registers `hostname` on the SaaS zone, with a DV certificate validated over
 * HTTP. `metadata` is stored with it (ids that tell us whose it is). Not
 * retried: a create is not idempotent, and a replay of one that succeeded
 * would come back as "already exists".
 */
export async function createCustomHostname(
  apiToken: string,
  zoneId: string,
  hostname: string,
  metadata: Record<string, string> = {},
): Promise<CustomHostnameState> {
  const created = await call(() =>
    client(apiToken).customHostnames.create(
      {
        zone_id: zoneId,
        hostname,
        ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
        ...(Object.keys(metadata).length > 0 ? { custom_metadata: metadata } : {}),
      },
      { maxRetries: 0 },
    ),
  );
  return toCustomHostnameState(created);
}

/** The host name's current state, or null when Cloudflare no longer has it. */
export async function getCustomHostname(apiToken: string, zoneId: string, id: string): Promise<CustomHostnameState | null> {
  try {
    const found = await call(() => client(apiToken).customHostnames.get(id, { zone_id: zoneId }));
    return toCustomHostnameState(found);
  } catch (err) {
    if (err instanceof CloudflareHostnameError && err.status === 404) return null;
    throw err;
  }
}

/** Removes the host name from the SaaS zone. A host name that is already gone counts as removed. */
export async function deleteCustomHostname(apiToken: string, zoneId: string, id: string): Promise<void> {
  try {
    await call(() => client(apiToken).customHostnames.delete(id, { zone_id: zoneId }));
  } catch (err) {
    if (err instanceof CloudflareHostnameError && err.status === 404) return;
    throw err;
  }
}

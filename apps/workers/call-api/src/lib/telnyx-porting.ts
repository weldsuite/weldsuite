/**
 * Telnyx porting API wrappers.
 *
 * Ported verbatim from apps/api-worker/src/lib/telnyx-porting.ts (W3 legacy
 * phase-out). Each function takes the worker Env (for the platform
 * TELNYX_API_KEY) and either returns parsed data or throws
 * TelnyxPortingError. The error carries a normalized `code` (so route
 * handlers can branch without string-matching the Telnyx message) plus the
 * original message + HTTP status for surfacing.
 */

import type { TelnyxEnv } from './telnyx';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

export type TelnyxPortingErrorCode =
  | 'unauthorized'              // 401
  | 'forbidden'                 // 403 (key lacks scope)
  | 'not_found'                 // 404 (deleted on Telnyx side)
  | 'conflict'                  // 409 (duplicate / state conflict)
  | 'validation_failed'         // 422
  | 'rate_limited'              // 429
  | 'telnyx_unavailable'        // 5xx / network
  | 'unknown';

export class TelnyxPortingError extends Error {
  readonly code: TelnyxPortingErrorCode;
  readonly httpStatus: number;
  readonly telnyxErrors: unknown;

  constructor(
    code: TelnyxPortingErrorCode,
    httpStatus: number,
    message: string,
    telnyxErrors: unknown = null,
  ) {
    super(message);
    this.name = 'TelnyxPortingError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.telnyxErrors = telnyxErrors;
  }
}

function classifyHttpStatus(status: number): TelnyxPortingErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'telnyx_unavailable';
  return 'unknown';
}

async function telnyxPortingRequest<T>(
  env: TelnyxEnv,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const apiKey = env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new TelnyxPortingError(
      'telnyx_unavailable',
      500,
      'Telnyx API key is not configured on this worker',
    );
  }

  const url = endpoint.startsWith('http') ? endpoint : `${TELNYX_API_BASE}${endpoint}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(options.body && !(options.headers as any)?.['Content-Type']
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...options.headers,
      },
    });
  } catch (networkErr) {
    throw new TelnyxPortingError(
      'telnyx_unavailable',
      0,
      `Telnyx network error: ${networkErr instanceof Error ? networkErr.message : 'unknown'}`,
    );
  }

  if (!response.ok) {
    // Read the body as text first so we always have something to log even
    // when Telnyx returns HTML (404 from a path they don't recognize) or
    // an empty body. Then try to parse JSON for the structured error.
    const rawText = await response.text().catch(() => '');
    let body: Record<string, any> | null = null;
    try {
      body = rawText ? (JSON.parse(rawText) as Record<string, any>) : null;
    } catch {
      body = null;
    }
    const telnyxDetail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title;
    const errorMsg = telnyxDetail
      ? `Telnyx ${response.status}: ${telnyxDetail}`
      : `Telnyx ${response.status} on ${endpoint} — ${response.statusText || 'no body'}${rawText ? ` — body: ${rawText.slice(0, 300)}` : ''}`;

    console.error('[TelnyxPorting] Request failed', {
      url,
      status: response.status,
      statusText: response.statusText,
      bodySnippet: rawText.slice(0, 500),
    });

    throw new TelnyxPortingError(
      classifyHttpStatus(response.status),
      response.status,
      errorMsg,
      body?.errors ?? null,
    );
  }

  if (response.status === 204) return {} as T;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/pdf') || contentType.includes('octet-stream')) {
    return (await response.arrayBuffer()) as unknown as T;
  }

  return (await response.json()) as T;
}

// ============================================================================
// Pre-flight check
// ============================================================================

export interface PreflightResult {
  /** True if Telnyx says the number can be ported in. */
  portable: boolean;
  /** Telnyx-provided reasons when not portable (rate centers, regions, etc.). */
  reasons: string[];
  /** Raw Telnyx response payload — kept for forensics. */
  raw: unknown;
}

export async function preflightCheck(
  env: TelnyxEnv,
  phoneNumbers: string[],
): Promise<PreflightResult> {
  // Telnyx Number Porting v2 — POST /portability_checks. Returns one entry
  // per number with `portable: bool` and an optional `not_portable_reason`.
  // (The older /porting_phone_number_check endpoint was removed in 2023.)
  const resp = await telnyxPortingRequest<{
    data: Array<{
      phone_number: string;
      portable: boolean;
      not_portable_reason?: string | null;
      fast_portable?: boolean;
      carrier_name?: string | null;
    }>;
  }>(env, '/portability_checks', {
    method: 'POST',
    body: JSON.stringify({ phone_numbers: phoneNumbers }),
  });

  const items = resp.data ?? [];
  const allPortable = items.length > 0 && items.every((i) => i.portable === true);
  const reasons: string[] = [];

  for (const item of items) {
    if (!item.portable) {
      reasons.push(
        item.not_portable_reason
          ? `${item.phone_number}: ${item.not_portable_reason}`
          : `${item.phone_number}: not portable`,
      );
    }
  }

  // Defensive: if Telnyx returned no items at all, treat as not portable
  // with a clear message rather than silently returning portable=true.
  if (items.length === 0) {
    reasons.push('Telnyx returned no portability data for this number');
  }

  return { portable: allPortable, reasons, raw: resp.data };
}

// ============================================================================
// Porting orders
// ============================================================================

export interface TelnyxPortingOrderSummary {
  id: string;
  status: string;
  /** Sometimes called sub_status; kept here as the more user-facing label. */
  substatus?: string;
  customerReference?: string;
  requestedFocDate?: string;
  actualFocDate?: string;
  phoneNumbers: Array<{ id?: string; phone_number: string }>;
  /** Telnyx may surface transient explanations here (rejection, exception). */
  messages?: string[];
}

interface TelnyxOrderRaw {
  id: string;
  status: string;
  sub_status?: string | null;
  customer_reference?: string | null;
  requested_foc_date?: string | null;
  actual_foc_date?: string | null;
  phone_numbers?: Array<{ id?: string; phone_number: string }>;
  messages?: Array<{ message?: string; code?: string }>;
}

function normalizeOrder(raw: TelnyxOrderRaw): TelnyxPortingOrderSummary {
  return {
    id: raw.id,
    status: raw.status,
    substatus: raw.sub_status ?? undefined,
    customerReference: raw.customer_reference ?? undefined,
    requestedFocDate: raw.requested_foc_date ?? undefined,
    actualFocDate: raw.actual_foc_date ?? undefined,
    phoneNumbers: raw.phone_numbers ?? [],
    messages: (raw.messages ?? []).map((m) => m.message || m.code || '').filter(Boolean),
  };
}

export async function createPortingOrder(
  env: TelnyxEnv,
  args: { phoneNumbers: string[]; customerReference: string },
): Promise<TelnyxPortingOrderSummary> {
  const resp = await telnyxPortingRequest<{ data: TelnyxOrderRaw }>(env, '/porting_orders', {
    method: 'POST',
    body: JSON.stringify({
      phone_numbers: args.phoneNumbers,
      customer_reference: args.customerReference,
    }),
  });
  return normalizeOrder(resp.data);
}

export async function getPortingOrder(
  env: TelnyxEnv,
  telnyxOrderId: string,
): Promise<TelnyxPortingOrderSummary> {
  const resp = await telnyxPortingRequest<{ data: TelnyxOrderRaw }>(
    env,
    `/porting_orders/${telnyxOrderId}`,
  );
  return normalizeOrder(resp.data);
}

export interface UpdatePortingOrderArgs {
  authorizedName?: string;
  businessName?: string;
  serviceAddress?: {
    line1: string;
    line2?: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };
  currentCarrier?: string;
  currentAccountNumber?: string;
  currentPin?: string;
  requestedFocDate?: string; // ISO date YYYY-MM-DD
}

export async function updatePortingOrder(
  env: TelnyxEnv,
  telnyxOrderId: string,
  args: UpdatePortingOrderArgs,
): Promise<TelnyxPortingOrderSummary> {
  const body: Record<string, unknown> = {};
  if (args.authorizedName) body.authorized_name = args.authorizedName;
  if (args.businessName) {
    // Telnyx end_user{} block carries the business + service-address fields
    body.end_user = {
      ...(body.end_user as object | undefined),
      admin: { business_name: args.businessName },
    };
  }
  if (args.serviceAddress) {
    body.end_user = {
      ...(body.end_user as object | undefined),
      location: {
        street_address: args.serviceAddress.line1,
        extended_address: args.serviceAddress.line2,
        locality: args.serviceAddress.city,
        administrative_area: args.serviceAddress.region,
        postal_code: args.serviceAddress.postalCode,
        country_code: args.serviceAddress.country,
      },
    };
  }
  if (args.currentCarrier || args.currentAccountNumber || args.currentPin) {
    body.misc = {
      ...(body.misc as object | undefined),
      ...(args.currentCarrier ? { current_carrier: args.currentCarrier } : {}),
      ...(args.currentAccountNumber ? { account_number: args.currentAccountNumber } : {}),
      ...(args.currentPin ? { pin_passcode: args.currentPin } : {}),
    };
  }
  if (args.requestedFocDate) body.requested_foc_date = args.requestedFocDate;

  const resp = await telnyxPortingRequest<{ data: TelnyxOrderRaw }>(
    env,
    `/porting_orders/${telnyxOrderId}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return normalizeOrder(resp.data);
}

/**
 * Fetch the pre-filled LOA template Telnyx generates for an order.
 * Returns raw PDF bytes — caller decides whether to stream to user or
 * persist in R2.
 */
export async function fetchLoaTemplate(env: TelnyxEnv, telnyxOrderId: string): Promise<ArrayBuffer> {
  const buf = await telnyxPortingRequest<ArrayBuffer>(
    env,
    `/porting_orders/${telnyxOrderId}/loa_template`,
    { headers: { Accept: 'application/pdf' } },
  );
  return buf;
}

/**
 * Attach a document (signed LOA or current carrier bill) to a Telnyx
 * porting order. We upload the PDF first via /documents (returns a doc id)
 * then PATCH the order to point at it — the cleanest two-step flow that
 * Telnyx documents.
 */
export async function attachOrderDocument(
  env: TelnyxEnv,
  args: {
    telnyxOrderId: string;
    pdfBytes: ArrayBuffer;
    /** Becomes the filename Telnyx shows reviewers. */
    filename: string;
    /** Telnyx document_type — 'loa' or 'invoice'. */
    documentType: 'loa' | 'invoice';
  },
): Promise<{ documentId: string }> {
  // Step 1 — POST /documents (multipart) to get a document id.
  const form = new FormData();
  form.append('file', new Blob([args.pdfBytes], { type: 'application/pdf' }), args.filename);
  const docResp = await telnyxPortingRequest<{ data: { id: string } }>(env, '/documents', {
    method: 'POST',
    body: form,
    // Don't set Content-Type — fetch will fill in the multipart boundary.
    headers: {},
  });
  const documentId = docResp.data.id;

  // Step 2 — PATCH the porting order's documents map. Field names are
  // 'loa' and 'invoice' in Telnyx's documents block.
  await telnyxPortingRequest(env, `/porting_orders/${args.telnyxOrderId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      documents: { [args.documentType]: documentId },
    }),
  });

  return { documentId };
}

export async function submitPortingOrder(
  env: TelnyxEnv,
  telnyxOrderId: string,
): Promise<TelnyxPortingOrderSummary> {
  const resp = await telnyxPortingRequest<{ data: TelnyxOrderRaw }>(
    env,
    `/porting_orders/${telnyxOrderId}/submit_for_approval`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return normalizeOrder(resp.data);
}

export async function deletePortingOrder(env: TelnyxEnv, telnyxOrderId: string): Promise<void> {
  await telnyxPortingRequest(env, `/porting_orders/${telnyxOrderId}`, { method: 'DELETE' });
}

/**
 * Sendcloud API v3 client.
 *
 * Auth is HTTP Basic with the merchant's public + secret keys.
 * Base URL: https://panel.sendcloud.sc/api/v3
 */

const DEFAULT_BASE_URL = 'https://panel.sendcloud.sc/api/v3';

export class SendcloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code:
      | 'UNAUTHORIZED'
      | 'PAYMENT_REQUIRED'
      | 'VALIDATION'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'UPSTREAM',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SendcloudError';
  }
}

export interface SendcloudCredentials {
  publicKey: string;
  secretKey: string;
}

export interface SendcloudSenderAddress {
  id: number;
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  houseNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string | null;
  isDefault?: boolean;
}

export interface SendcloudShippingOption {
  code: string;
  name: string;
  carrierCode?: string | null;
  carrierName?: string | null;
  minWeightKg?: number | null;
  maxWeightKg?: number | null;
  servicePointRequired: boolean;
  isReturn: boolean;
}

export interface SendcloudAddress {
  sender_address_id?: number;
  name?: string;
  company_name?: string;
  address_line_1?: string;
  address_line_2?: string;
  house_number?: string;
  postal_code?: string;
  city?: string;
  country_code?: string;
  email?: string;
  phone_number?: string;
  state_province_code?: string;
}

export interface AnnounceShipmentInput {
  senderAddressId: number;
  toAddress: SendcloudAddress;
  shippingOptionCode: string;
  weightKg: number;
  orderNumber?: string | null;
}

export interface AnnouncedParcel {
  id: number;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  labelPdfBase64?: string | null;
  labelDocumentUrl?: string | null;
  statusCode?: string | null;
}

export interface AnnouncedShipment {
  id: string | number;
  carrierCode?: string | null;
  carrierName?: string | null;
  shippingOptionCode?: string | null;
  errors: Array<{ message?: string; code?: string }>;
  parcel: AnnouncedParcel | null;
}

export interface SendcloudClient {
  listSenderAddresses(): Promise<SendcloudSenderAddress[]>;
  listShippingOptions(params: {
    from: SendcloudAddress;
    to: SendcloudAddress;
    weightKg?: number;
  }): Promise<SendcloudShippingOption[]>;
  announceShipment(input: AnnounceShipmentInput): Promise<AnnouncedShipment>;
  getParcelDocument(parcelId: number, type?: 'label'): Promise<{ bytes: ArrayBuffer; contentType: string }>;
}

type FetchFn = typeof fetch;

export function createSendcloudClient(
  credentials: SendcloudCredentials,
  options?: { fetch?: FetchFn; baseUrl?: string },
): SendcloudClient {
  const fetchImpl = options?.fetch ?? fetch;
  const baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const auth = `Basic ${btoa(`${credentials.publicKey}:${credentials.secretKey}`)}`;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', auth);
    headers.set('Accept', headers.get('Accept') || 'application/json');
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
    if (res.ok) return res;
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = await res.text().catch(() => undefined);
    }
    const message = extractErrorMessage(details) || `Sendcloud request failed (${res.status})`;
    throw new SendcloudError(message, res.status, classifyStatus(res.status), details);
  }

  async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await request(path, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    async listSenderAddresses() {
      const collected: SendcloudSenderAddress[] = [];
      let path: string | null = '/addresses/sender-addresses?page_size=100';
      while (path) {
        const res = await request(path);
        const json = (await res.json()) as Record<string, unknown>;
        const rows = extractList(json);
        collected.push(...rows.map(mapSender));
        path = nextPath(res.headers.get('Link'), json, baseUrl);
      }
      return collected;
    },

    async listShippingOptions(params) {
      const json = await requestJson<Record<string, unknown>>('/shipping-options', {
        method: 'POST',
        body: JSON.stringify({
          from_address: params.from,
          to_address: params.to,
          parcels: [{ weight: { value: String(params.weightKg ?? 1), unit: 'kg' } }],
          calculate_quotes: false,
        }),
      });
      return extractList(json).map(mapShippingOption).filter((row) => row.code);
    },

    async announceShipment(input) {
      const json = await requestJson<Record<string, unknown>>('/shipments/announce', {
        method: 'POST',
        body: JSON.stringify({
          label_details: { mime_type: 'application/pdf', dpi: 72 },
          from_address: { sender_address_id: input.senderAddressId },
          to_address: input.toAddress,
          ship_with: {
            type: 'shipping_option_code',
            properties: { shipping_option_code: input.shippingOptionCode },
          },
          order_number: input.orderNumber ?? undefined,
          parcels: [{ weight: { value: String(input.weightKg), unit: 'kg' } }],
        }),
      });
      const data = (json.data ?? json) as Record<string, unknown>;
      const parcels = Array.isArray(data.parcels) ? data.parcels : [];
      const first = (parcels[0] ?? null) as Record<string, unknown> | null;
      const documents = Array.isArray(first?.documents) ? first.documents : [];
      const labelDoc = documents.find((doc) => (doc as { type?: string }).type === 'label') as
        | { link?: string }
        | undefined;
      const carrier = (data.carrier ?? {}) as Record<string, unknown>;
      const shipWith = (data.ship_with ?? {}) as { properties?: { shipping_option_code?: string } };
      const errors = Array.isArray(data.errors)
        ? (data.errors as Array<{ message?: string; code?: string }>)
        : [];
      return {
        id: (data.id as string | number) ?? '',
        carrierCode: typeof carrier.code === 'string' ? carrier.code : null,
        carrierName: typeof carrier.name === 'string' ? carrier.name : null,
        shippingOptionCode: shipWith.properties?.shipping_option_code ?? input.shippingOptionCode,
        errors,
        parcel: first
          ? {
              id: Number(first.id),
              trackingNumber: typeof first.tracking_number === 'string' ? first.tracking_number : null,
              trackingUrl: typeof first.tracking_url === 'string' ? first.tracking_url : null,
              labelPdfBase64: typeof first.label_file === 'string' ? first.label_file : null,
              labelDocumentUrl: labelDoc?.link ?? null,
              statusCode:
                typeof (first.status as { code?: string } | undefined)?.code === 'string'
                  ? (first.status as { code: string }).code
                  : null,
            }
          : null,
      };
    },

    async getParcelDocument(parcelId, type = 'label') {
      const res = await request(`/parcels/${parcelId}/documents/${type}`, {
        headers: { Accept: 'application/pdf' },
      });
      return {
        bytes: await res.arrayBuffer(),
        contentType: res.headers.get('Content-Type') || 'application/pdf',
      };
    },
  };
}

function classifyStatus(status: number): SendcloudError['code'] {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 402) return 'PAYMENT_REQUIRED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VALIDATION';
  return 'UPSTREAM';
}

function extractErrorMessage(details: unknown): string | null {
  if (!details) return null;
  if (typeof details === 'string') return details;
  if (typeof details !== 'object') return null;
  const rec = details as Record<string, unknown>;
  const error = rec.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: string }).message === 'string') {
    return (error as { message: string }).message;
  }
  if (typeof rec.message === 'string') return rec.message;
  if (Array.isArray(rec.errors) && rec.errors[0]) {
    const first = rec.errors[0] as { message?: string };
    if (typeof first.message === 'string') return first.message;
  }
  return null;
}

function extractList(json: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(json.data)) return json.data as Array<Record<string, unknown>>;
  if (Array.isArray(json.sender_addresses)) return json.sender_addresses as Array<Record<string, unknown>>;
  if (Array.isArray(json.shipping_options)) return json.shipping_options as Array<Record<string, unknown>>;
  if (Array.isArray(json.items)) return json.items as Array<Record<string, unknown>>;
  return [];
}

function nextPath(linkHeader: string | null, json: Record<string, unknown>, baseUrl: string): string | null {
  const fromLink = parseLinkNext(linkHeader);
  if (fromLink) {
    if (fromLink.startsWith('http')) return fromLink.replace(baseUrl, '') || '/';
    return fromLink;
  }
  const cursor =
    (typeof json.next === 'string' ? json.next : null) ||
    (typeof (json.pagination as { next?: string } | undefined)?.next === 'string'
      ? (json.pagination as { next: string }).next
      : null);
  if (!cursor) return null;
  if (cursor.startsWith('http')) return cursor.replace(baseUrl, '');
  if (cursor.startsWith('/')) return cursor;
  return `/addresses/sender-addresses?cursor=${encodeURIComponent(cursor)}&page_size=100`;
}

function parseLinkNext(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.trim().match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function mapSender(row: Record<string, unknown>): SendcloudSenderAddress {
  const country = asString(row.country) ?? asString(row.country_code);
  return {
    id: Number(row.id),
    companyName: asString(row.company_name),
    contactName: asString(row.contact_name) ?? asString(row.name),
    email: asString(row.email),
    phone: asString(row.phone_number) ?? asString(row.telephone),
    addressLine1: asString(row.address_line_1) ?? asString(row.street),
    addressLine2: asString(row.address_line_2),
    houseNumber: asString(row.house_number),
    postalCode: asString(row.postal_code),
    city: asString(row.city),
    countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : country,
    isDefault: Boolean(row.is_default ?? row.default),
  };
}

function mapShippingOption(row: Record<string, unknown>): SendcloudShippingOption {
  const carrier = (row.carrier ?? {}) as Record<string, unknown>;
  const product = (row.product ?? {}) as Record<string, unknown>;
  const weight = (row.weight ?? {}) as { min?: { value?: string }; max?: { value?: string } };
  const requirements = (row.requirements ?? {}) as { is_service_point_required?: boolean };
  const functionalities = (row.functionalities ?? {}) as { returns?: boolean };
  const code = asString(row.code) ?? '';
  return {
    code,
    name: asString(product.name) ?? asString(row.name) ?? code,
    carrierCode: asString(carrier.code),
    carrierName: asString(carrier.name),
    minWeightKg: asNumber(weight.min?.value),
    maxWeightKg: asNumber(weight.max?.value),
    servicePointRequired: Boolean(requirements.is_service_point_required),
    isReturn: Boolean(functionalities.returns),
  };
}

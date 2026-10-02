/**
 * Telnyx regulatory requirements for ordering a number (documents, address, text).
 */

import { telnyxRequest, type TelnyxEnv } from '../lib/telnyx';

export type PhoneRequirementFieldType = 'textual' | 'address' | 'document' | 'action' | 'datetime';

export interface PhoneOrderingRequirement {
  id: string;
  name: string;
  description: string;
  fieldType: PhoneRequirementFieldType;
  example?: string;
}

export interface RequirementValue {
  requirementId: string;
  fieldValue: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function fieldTypeOf(raw: unknown): PhoneRequirementFieldType {
  const type = String(raw ?? '').toLowerCase();
  if (type === 'address' || type === 'document' || type === 'action' || type === 'datetime') return type;
  return 'textual';
}

export function flattenOrderingRequirements(raw: unknown[]): PhoneOrderingRequirement[] {
  const out: PhoneOrderingRequirement[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {
    const row = asRecord(node);
    if (!row) return;
    const recordType = String(row.record_type ?? '');
    const nested =
      (Array.isArray(row.requirement_types) ? row.requirement_types : null) ??
      (Array.isArray(row.requirements) ? row.requirements : null) ??
      [];

    const looksLikeType =
      recordType === 'requirement_type' ||
      typeof row.type === 'string' ||
      typeof row.field_type === 'string';

    if (looksLikeType && typeof row.id === 'string' && row.id && !seen.has(row.id)) {
      seen.add(row.id);
      out.push({
        id: row.id,
        name: String(row.name ?? row.title ?? 'Requirement'),
        description: String(row.description ?? row.example ?? ''),
        fieldType: fieldTypeOf(row.type ?? row.field_type),
        example: typeof row.example === 'string' ? row.example : undefined,
      });
    }

    for (const child of nested) visit(child);
  };

  for (const item of raw) visit(item);
  return out;
}

export async function listOrderingRequirements(
  env: TelnyxEnv,
  countryCode: string,
  numberType: string,
): Promise<PhoneOrderingRequirement[]> {
  const params = new URLSearchParams();
  params.set('filter[country_code]', countryCode.toUpperCase());
  params.set('filter[phone_number_type]', numberType.replace(/-/g, '_'));
  params.set('filter[action]', 'ordering');

  try {
    const resp = await telnyxRequest<{ data?: unknown[] }>(env, `/requirements?${params.toString()}`);
    return flattenOrderingRequirements(resp.data ?? []);
  } catch {
    const fallback = await telnyxRequest<{ data?: unknown[] }>(
      env,
      `/phone_number_regulatory_requirements?${params.toString()}`,
    );
    return flattenOrderingRequirements(fallback.data ?? []);
  }
}

export async function uploadTelnyxDocument(
  env: TelnyxEnv,
  file: File,
): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  form.append('file', file, file.name);
  const resp = await telnyxRequest<{ data?: { id?: string; filename?: string } }>(env, '/documents', {
    method: 'POST',
    body: form,
    headers: {},
  });
  const id = resp.data?.id;
  if (!id) throw new Error('Telnyx did not return a document id');
  return { id, filename: resp.data?.filename || file.name };
}

export async function createOrderingRequirementGroup(
  env: TelnyxEnv,
  args: {
    countryCode: string;
    numberType: string;
    customerReference: string;
    values: RequirementValue[];
  },
): Promise<{ id: string }> {
  const resp = await telnyxRequest<{ data?: { id?: string } }>(env, '/requirement_groups', {
    method: 'POST',
    body: JSON.stringify({
      country_code: args.countryCode.toUpperCase(),
      phone_number_type: args.numberType.replace(/-/g, '_'),
      action: 'ordering',
      customer_reference: args.customerReference.slice(0, 100),
      regulatory_requirements: args.values.map((v) => ({
        requirement_id: v.requirementId,
        field_value: v.fieldValue,
      })),
    }),
  });
  const id = resp.data?.id;
  if (!id) throw new Error('Telnyx did not return a requirement group id');
  return { id };
}

export interface TelnyxOrderPhoneNumber {
  id?: string;
  phone_number?: string;
  status?: string;
  requirements_met?: boolean;
  regulatory_requirements?: Array<{
    requirement_id?: string;
    field_type?: string;
    field_value?: string;
    status?: string;
  }>;
}

export interface TelnyxNumberOrder {
  id?: string;
  status?: string;
  phone_numbers?: TelnyxOrderPhoneNumber[];
}

export function telnyxOrderNeedsDocuments(order: { phone_numbers?: TelnyxOrderPhoneNumber[] } | null | undefined): boolean {
  const numbers = order?.phone_numbers ?? [];
  if (numbers.length === 0) return false;
  return numbers.some((n) => n.requirements_met === false);
}

export interface PendingOrderRequirement extends PhoneOrderingRequirement {
  fieldValue?: string;
  status?: string;
}

export interface PhoneNumberOrderRequirements {
  orderId: string;
  phoneNumberOrderId: string;
  requirementsMet: boolean;
  requirements: PendingOrderRequirement[];
}

function pickOrder(
  rows: TelnyxNumberOrder[],
  phoneNumber: string,
): TelnyxNumberOrder | undefined {
  const e164 = phoneNumber.trim();
  return (
    rows.find((o) => o.phone_numbers?.some((n) => n.phone_number === e164)) ??
    rows[0]
  );
}

export async function findNumberOrderForPhone(
  env: TelnyxEnv,
  args: { customerReference: string; phoneNumber: string },
): Promise<TelnyxNumberOrder | null> {
  const byRef = new URLSearchParams();
  byRef.set('filter[customer_reference]', args.customerReference);
  byRef.set('page[size]', '20');
  const refResp = await telnyxRequest<{ data?: TelnyxNumberOrder[] }>(
    env,
    `/number_orders?${byRef.toString()}`,
  );
  const fromRef = pickOrder(refResp.data ?? [], args.phoneNumber);
  if (fromRef) return fromRef;

  const byNumber = new URLSearchParams();
  byNumber.set('filter[phone_number]', args.phoneNumber);
  byNumber.set('page[size]', '20');
  const numResp = await telnyxRequest<{ data?: TelnyxNumberOrder[] }>(
    env,
    `/number_orders?${byNumber.toString()}`,
  );
  return pickOrder(numResp.data ?? [], args.phoneNumber) ?? null;
}

export async function listPendingOrderRequirements(
  env: TelnyxEnv,
  args: { customerReference: string; phoneNumber: string; countryCode: string; numberType: string },
): Promise<PhoneNumberOrderRequirements | null> {
  const order = await findNumberOrderForPhone(env, args);
  const orderId = order?.id;
  const line =
    order?.phone_numbers?.find((n) => n.phone_number === args.phoneNumber) ??
    order?.phone_numbers?.[0];
  if (!orderId || !line?.id) return null;

  const catalog = await listOrderingRequirements(env, args.countryCode, args.numberType);
  const byId = new Map(catalog.map((r) => [r.id, r]));
  const rawReqs = line.regulatory_requirements ?? [];
  const requirements: PendingOrderRequirement[] =
    rawReqs.length > 0
      ? rawReqs
          .filter((r): r is { requirement_id: string } & typeof r => Boolean(r.requirement_id))
          .map((r) => {
            const meta = byId.get(r.requirement_id);
            return {
              id: r.requirement_id,
              name: meta?.name ?? 'Requirement',
              description: meta?.description ?? '',
              fieldType: fieldTypeOf(r.field_type ?? meta?.fieldType),
              example: meta?.example,
              fieldValue: r.field_value || undefined,
              status: r.status,
            };
          })
      : catalog;

  return {
    orderId,
    phoneNumberOrderId: line.id,
    requirementsMet: line.requirements_met === true,
    requirements,
  };
}

export async function submitNumberOrderRequirements(
  env: TelnyxEnv,
  args: { phoneNumberOrderId: string; values: RequirementValue[] },
): Promise<{ requirementsMet: boolean }> {
  const resp = await telnyxRequest<{ data?: TelnyxOrderPhoneNumber }>(
    env,
    `/number_order_phone_numbers/${encodeURIComponent(args.phoneNumberOrderId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        regulatory_requirements: args.values.map((v) => ({
          requirement_id: v.requirementId,
          field_value: v.fieldValue,
        })),
      }),
    },
  );
  return { requirementsMet: resp.data?.requirements_met === true };
}

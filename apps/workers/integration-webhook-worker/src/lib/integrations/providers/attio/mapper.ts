import type { MappedCompany, MappedPerson, ExternalRecord } from '../../types';

/**
 * Extract a simple attribute value from Attio record values.
 * Attio stores values as arrays of typed objects.
 */
function getAttrValue(values: Record<string, unknown>, key: string): string | undefined {
  const arr = values[key] as Array<{ value?: unknown; first_name?: string; last_name?: string; full_name?: string; original?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;

  const item = arr[0]!;
  if (typeof item === 'string') return item;
  if (item.value !== undefined && item.value !== null) return String(item.value);
  if (item.original) return item.original;
  return undefined;
}

/**
 * Extract email from Attio record values.
 */
function getEmail(values: Record<string, unknown>): string | undefined {
  const arr = values['email_addresses'] as Array<{ email_address?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.email_address;
}

/**
 * Extract phone from Attio record values.
 */
function getPhone(values: Record<string, unknown>): string | undefined {
  const arr = values['phone_numbers'] as Array<{ phone_number?: string; original_phone_number?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.original_phone_number || arr[0]?.phone_number;
}

/**
 * Extract name parts from Attio person record.
 */
function getName(values: Record<string, unknown>): { firstName?: string; lastName?: string; fullName?: string } {
  const nameArr = values['name'] as Array<{ first_name?: string; last_name?: string; full_name?: string }> | undefined;
  if (!nameArr || nameArr.length === 0) return {};
  const name = nameArr[0]!;
  return {
    firstName: name.first_name || undefined,
    lastName: name.last_name || undefined,
    fullName: name.full_name || undefined,
  };
}

/**
 * Extract domain from Attio company record.
 */
function getDomain(values: Record<string, unknown>): string | undefined {
  const arr = values['domains'] as Array<{ domain?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.domain;
}

/**
 * Extract company name from Attio record.
 */
function getCompanyName(values: Record<string, unknown>): string | undefined {
  const arr = values['name'] as Array<{ value?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.value;
}

/**
 * Extract description from Attio record.
 */
function getDescription(values: Record<string, unknown>): string | undefined {
  const arr = values['description'] as Array<{ value?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.value;
}

/**
 * Extract categories/tags from Attio record.
 */
function getCategories(values: Record<string, unknown>): string[] | undefined {
  const arr = values['categories'] as Array<{ option?: { title?: string } }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr.map(c => c.option?.title).filter(Boolean) as string[];
}

/**
 * Check if an Attio person record has a company association.
 * Returns the company record_id if found.
 */
export function getCompanyRecordId(values: Record<string, unknown>): string | undefined {
  const arr = values['company'] as Array<{ target_record_id?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.target_record_id;
}

/**
 * Map an Attio company record to a WeldSuite Company.
 */
export function mapAttioCompany(record: ExternalRecord): MappedCompany {
  const values = record.data as Record<string, unknown>;
  const domain = getDomain(values);
  const name = getCompanyName(values) || 'Unknown Company';

  return {
    data: {
      name,
      displayName: name,
      email: getEmail(values),
      website: domain ? `https://${domain}` : undefined,
      notes: getDescription(values),
      tags: getCategories(values),
      status: 'active',
      source: 'attio',
    },
  };
}

/**
 * Map an Attio person record to a WeldSuite Person. When the record has a
 * parent-company link, `parentCompanyExternalId` is set so the sync layer can
 * create a `person_companies` junction row.
 */
export function mapAttioPerson(record: ExternalRecord): MappedPerson {
  const values = record.data as Record<string, unknown>;
  const { firstName, lastName, fullName } = getName(values);
  const displayName =
    fullName ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    getEmail(values) ||
    'Unknown';

  return {
    data: {
      firstName: firstName || null,
      lastName: lastName || null,
      fullName: fullName || null,
      displayName,
      email: getEmail(values),
      directPhone: getPhone(values),
      title: getAttrValue(values, 'job_title'),
      status: 'active',
      source: 'attio',
    },
    parentCompanyExternalId: getCompanyRecordId(values),
  };
}

/**
 * Compute a SHA-256 checksum of the record data for change detection.
 */
export async function computeChecksum(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const encoded = new TextEncoder().encode(json);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * CRM lookup for WeldDesk inbound voice — match callers by phone, then
 * search people / companies / leads by name or email.
 */

import { and, ilike, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import { normalizeE164 } from '../lib/phone-registry';

export interface CrmLookupHit {
  type: 'contact' | 'customer' | 'lead';
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
}

export interface CallerMatch {
  contactId: string | null;
  customerId: string | null;
  callerName: string | null;
  customerName: string | null;
  email: string | null;
  hits: CrmLookupHit[];
}

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Last 8 national digits — matches +32 vs 0475 vs 0032 forms via SQL LIKE. */
export function phoneLookupSuffix(phone: string, min = 8): string | null {
  const d = digitsOnly(phone);
  if (d.length < min) return null;
  return d.slice(-min);
}

function comparableDigits(phone: string): string {
  let d = digitsOnly(phone);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (normalizeE164(a) === normalizeE164(b)) return true;
  const ca = comparableDigits(a);
  const cb = comparableDigits(b);
  if (!ca || !cb) return false;
  if (ca === cb || ca.endsWith(cb) || cb.endsWith(ca)) return true;
  if (ca.length < 8 || cb.length < 8) return false;
  return ca.slice(-8) === cb.slice(-8);
}

function phoneDigitsLike(column: unknown, suffix: string) {
  return sql`regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g') like ${`%${suffix}`}`;
}

function hitName(parts: Array<string | null | undefined>, fallback: string): string {
  const joined = parts.map((p) => p?.trim()).filter(Boolean).join(' ').trim();
  return joined || fallback;
}

export async function lookupCrm(
  db: Database,
  query: string,
  limit = 5,
): Promise<CrmLookupHit[]> {
  const q = query.trim();
  if (!q) return [];

  const looksLikePhone = digitsOnly(q).length >= 8;
  const suffix = looksLikePhone ? phoneLookupSuffix(q) : null;
  const like = `%${q.toLowerCase()}%`;
  const hits: CrmLookupHit[] = [];

  const peopleWhere = suffix
    ? or(
        phoneDigitsLike(schema.people.directPhone, suffix),
        phoneDigitsLike(schema.people.mobilePhone, suffix),
      )
    : or(
        sql`lower(${schema.people.displayName}) like ${like}`,
        sql`lower(coalesce(${schema.people.email}, '')) like ${like}`,
        ilike(schema.people.firstName, like),
        ilike(schema.people.lastName, like),
      );

  const peopleRows = await db
    .select({
      id: schema.people.id,
      displayName: schema.people.displayName,
      email: schema.people.email,
      directPhone: schema.people.directPhone,
      mobilePhone: schema.people.mobilePhone,
    })
    .from(schema.people)
    .where(and(isNull(schema.people.deletedAt), peopleWhere))
    .limit(limit);

  for (const row of peopleRows) {
    hits.push({
      type: 'contact',
      id: row.id,
      name: row.displayName,
      email: row.email,
      phone: row.mobilePhone || row.directPhone,
      companyName: null,
    });
  }

  const companyWhere = suffix
    ? or(phoneDigitsLike(schema.companies.phone, suffix), phoneDigitsLike(schema.companies.mobile, suffix))
    : or(
        sql`lower(${schema.companies.displayName}) like ${like}`,
        sql`lower(coalesce(${schema.companies.name}, '')) like ${like}`,
        sql`lower(coalesce(${schema.companies.email}, '')) like ${like}`,
      );

  const companyRows = await db
    .select({
      id: schema.companies.id,
      displayName: schema.companies.displayName,
      name: schema.companies.name,
      email: schema.companies.email,
      phone: schema.companies.phone,
      mobile: schema.companies.mobile,
    })
    .from(schema.companies)
    .where(and(isNull(schema.companies.deletedAt), companyWhere))
    .limit(limit);

  for (const row of companyRows) {
    hits.push({
      type: 'customer',
      id: row.id,
      name: row.displayName || row.name,
      email: row.email,
      phone: row.phone || row.mobile,
      companyName: row.displayName || row.name,
    });
  }

  const leadWhere = suffix
    ? or(phoneDigitsLike(schema.crmLeads.phone, suffix), phoneDigitsLike(schema.crmLeads.mobile, suffix))
    : or(
        sql`lower(coalesce(${schema.crmLeads.fullName}, '')) like ${like}`,
        sql`lower(coalesce(${schema.crmLeads.companyName}, '')) like ${like}`,
        sql`lower(${schema.crmLeads.email}) like ${like}`,
        ilike(schema.crmLeads.firstName, like),
        ilike(schema.crmLeads.lastName, like),
      );

  const leadRows = await db
    .select({
      id: schema.crmLeads.id,
      firstName: schema.crmLeads.firstName,
      lastName: schema.crmLeads.lastName,
      fullName: schema.crmLeads.fullName,
      companyName: schema.crmLeads.companyName,
      email: schema.crmLeads.email,
      phone: schema.crmLeads.phone,
      mobile: schema.crmLeads.mobile,
    })
    .from(schema.crmLeads)
    .where(and(isNull(schema.crmLeads.deletedAt), leadWhere))
    .limit(limit);

  for (const row of leadRows) {
    hits.push({
      type: 'lead',
      id: row.id,
      name: hitName([row.fullName, row.firstName, row.lastName], row.email),
      email: row.email,
      phone: row.phone || row.mobile,
      companyName: row.companyName,
    });
  }

  return hits.slice(0, limit);
}

export async function matchCallerByPhone(db: Database, fromNumber: string): Promise<CallerMatch> {
  const hits = await lookupCrm(db, fromNumber, 5);
  const contact = hits.find((h) => h.type === 'contact') ?? null;
  const customer = hits.find((h) => h.type === 'customer') ?? null;
  const lead = hits.find((h) => h.type === 'lead') ?? null;

  return {
    contactId: contact?.id ?? null,
    customerId: customer?.id ?? null,
    callerName: contact?.name ?? lead?.name ?? customer?.name ?? null,
    customerName: customer?.name ?? lead?.companyName ?? null,
    email: contact?.email ?? customer?.email ?? lead?.email ?? null,
    hits,
  };
}

export function formatCrmLookupForAssistant(hits: CrmLookupHit[]): Record<string, unknown> {
  if (hits.length === 0) {
    return { matched: 0, results: [], message: 'No matching CRM records.' };
  }
  return {
    matched: hits.length,
    results: hits.map((h) => ({
      type: h.type,
      id: h.id,
      name: h.name,
      email: h.email,
      phone: h.phone,
      company: h.companyName,
    })),
  };
}

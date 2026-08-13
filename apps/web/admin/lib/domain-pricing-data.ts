import 'server-only';

import { asc } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';

const { hostDomainPricing } = masterSchema;

export interface DomainPricingRow {
  id: string;
  tld: string;
  registrationPrice: string;
  renewalPrice: string;
  transferPrice: string;
  currency: string;
  isActive: boolean;
  isPopular: boolean;
  markupAmount: number | null;
  markupPercent: string | null;
  registrar: string | null;
  updatedAt: string;
}

export interface DomainPricingStats {
  total: number;
  active: number;
  popular: number;
}

function serialize(row: typeof hostDomainPricing.$inferSelect): DomainPricingRow {
  return {
    id: row.id,
    tld: row.tld,
    registrationPrice: String(row.registrationPrice),
    renewalPrice: String(row.renewalPrice),
    transferPrice: String(row.transferPrice),
    currency: row.currency,
    isActive: row.isActive,
    isPopular: Boolean(row.isPopular),
    markupAmount: row.markupAmount,
    markupPercent: row.markupPercent != null ? String(row.markupPercent) : null,
    registrar: row.registrar,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listDomainPricing(): Promise<DomainPricingRow[]> {
  const db = getMasterDb();
  const rows = await db
    .select()
    .from(hostDomainPricing)
    .orderBy(asc(hostDomainPricing.tld));
  return rows.map(serialize);
}

export async function listExistingDomainTlds(): Promise<string[]> {
  const db = getMasterDb();
  const rows = await db.select({ tld: hostDomainPricing.tld }).from(hostDomainPricing);
  return rows.map((r) => r.tld);
}

/**
 * Curing exempt sales with a certificate that arrives after the sale.
 *
 * Under the Streamlined Sales Tax rules a seller is protected when it obtains
 * a complete exemption certificate within 90 days of an exempt sale. Recording
 * such a certificate links the customer's earlier exempt tax-ledger rows in
 * the states it covers, so they leave the missing-certificates report and stay
 * exempt on the return. Rows a filed return already includes are left alone.
 */

import { and, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { addDays } from '@weldsuite/books-domain/sales-tax/dates';

const CURE_DAYS = 90;

export interface CuringCertificate {
  id: string;
  partyId: string;
  states: string[];
  status: string;
  blanket: boolean | null;
  invoiceId: string | null;
  receivedOn: string | null;
}

/** Links the certificate to the customer's uncured exempt sales it covers; returns how many documents it cured. */
export async function linkCertificateToEarlierSales(
  db: Database,
  entityId: string,
  certificate: CuringCertificate,
  today: string,
): Promise<number> {
  if (certificate.status !== 'valid' || certificate.states.length === 0) return 0;
  const tl = schema.taxLines;
  const received = certificate.receivedOn ?? today;
  const state = sql<string>`upper(coalesce(nullif(${tl.shipToState}, ''), ${tl.stateCode}))`;

  const conditions = [
    eq(tl.entityId, entityId),
    eq(tl.contactId, certificate.partyId),
    eq(tl.direction, 'sales'),
    isNull(tl.certificateId),
    isNull(tl.taxReturnId),
    gt(sql`coalesce(${tl.exemptAmount}, 0)`, 0),
    inArray(state, certificate.states.map((s) => s.toUpperCase())),
    gte(tl.taxDate, addDays(received, -CURE_DAYS)),
  ];
  // A single-purchase certificate covers its own invoice only.
  if (certificate.blanket === false) {
    if (!certificate.invoiceId) return 0;
    conditions.push(eq(tl.sourceType, 'invoice'), eq(tl.sourceId, certificate.invoiceId));
  }

  const linked = await db
    .update(tl)
    .set({ certificateId: certificate.id })
    .where(and(...conditions))
    .returning({ sourceType: tl.sourceType, sourceId: tl.sourceId });
  return new Set(linked.map((r) => `${r.sourceType}:${r.sourceId}`)).size;
}

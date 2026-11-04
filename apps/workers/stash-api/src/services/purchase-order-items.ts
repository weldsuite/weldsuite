/**
 * Purchase order lines (`purchase_order_items`): the amounts the server works
 * out for a line, and the project check of its cost tag (FLOW-019).
 *
 * Amounts are whole cents until they are written, so a TypeScript and a Rust
 * backend reach the same text: line = quantity x unit price, less the
 * discount percentage, plus tax on what is left; each step rounds to the cent
 * (half up, like `Math.round`).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export interface LineFigures {
  quantityOrdered: number;
  quantityReceived: number;
  /** Whole currency units, at most two decimals. */
  unitPrice: number;
  discountPercent: number;
  taxPercent: number;
}

/** A whole number of cents as the numeric column text (`12345` -> `123.45`). */
export function centsText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A price or percentage typed with at most two decimals, as the numeric column text. */
export function twoDecimalText(value: number): string {
  return centsText(Math.round(value * 100));
}

/** The columns the server fills from a line's figures. */
export function lineAmounts(line: LineFigures) {
  const gross = line.quantityOrdered * Math.round(line.unitPrice * 100);
  const discount = Math.round((gross * line.discountPercent) / 100);
  const net = gross - discount;
  const tax = Math.round((net * line.taxPercent) / 100);
  return {
    unitPrice: twoDecimalText(line.unitPrice),
    discountPercent: twoDecimalText(line.discountPercent),
    taxPercent: twoDecimalText(line.taxPercent),
    discountAmount: centsText(discount),
    taxAmount: centsText(tax),
    total: centsText(net + tax),
    // What is still to come in: ordered less received (never below zero).
    quantityPending: Math.max(line.quantityOrdered - line.quantityReceived, 0),
  };
}

/** The project of a line (FLOW-019) must be a live WeldFlow project of this workspace: the column has no foreign key, so this is the only check. */
export async function liveProjectExists(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return !!row;
}

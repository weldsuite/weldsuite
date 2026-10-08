/**
 * US sales tax return worksheet per agency and period, from tax-ledger lines.
 *
 * Placeholder signature; implemented by the sales tax engine work.
 */

import type { Entity } from '@weldsuite/db/schema';
import type { TaxReturnArtifact, TaxReturnLine } from '../types';

export function buildUsSalesTaxReturn(
  _entity: Entity,
  _periodStart: string,
  _periodEnd: string,
  _lines: TaxReturnLine[],
): Promise<TaxReturnArtifact> {
  return Promise.reject(new Error('US sales tax return worksheet is not implemented yet'));
}

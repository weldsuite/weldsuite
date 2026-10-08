/**
 * Sourcing: which address a sale is taxed at (research sales-tax.md §4).
 *
 * Interstate sales are destination-sourced everywhere. An intrastate sale
 * follows the state's rule in `us/states.ts`: origin states tax at the seller's
 * location, California (modified origin) taxes state, county and city at the
 * seller and district taxes at the buyer. A use tax accrual is always taxed at
 * the delivery address.
 */

import type { PostalAddress } from '@weldsuite/db/schema';
import { US_STATES, getUsState } from '../jurisdictions/us/states';
import type { JurisdictionLevel } from './types';

export type SourcingKind = 'origin' | 'modified_origin' | 'destination';
export type AddressSide = 'origin' | 'destination';

export interface SourcingDecision {
  sourcing: SourcingKind;
  /** USPS code of the state whose tax applies: the ship-to state. */
  taxingState: string;
  interstate: boolean;
  /** The address each jurisdiction level is taxed at. */
  levelSource: Record<JurisdictionLevel, AddressSide>;
}

const STATE_BY_NAME = new Map(US_STATES.map((s) => [s.name.toLowerCase(), s.code as string]));

/** Two-letter USPS code of an address, from a code or a full state name. Undefined when it has none. */
export function stateCodeOf(address: PostalAddress | null | undefined): string | undefined {
  const raw = address?.state?.trim();
  if (!raw) return undefined;
  if (raw.length === 2) return raw.toUpperCase();
  return STATE_BY_NAME.get(raw.toLowerCase()) ?? raw.toUpperCase();
}

/** The five-digit ZIP of an address (ZIP+4 is cut back), or undefined. */
export function zip5Of(address: PostalAddress | null | undefined): string | undefined {
  const raw = address?.postalCode?.trim();
  if (!raw) return undefined;
  const match = /^(\d{5})(?:[-\s]?\d{4})?$/.exec(raw);
  return match ? match[1] : undefined;
}

const ALL_DESTINATION: Record<JurisdictionLevel, AddressSide> = {
  state: 'destination',
  county: 'destination',
  city: 'destination',
  district: 'destination',
};

const ALL_ORIGIN: Record<JurisdictionLevel, AddressSide> = {
  state: 'origin',
  county: 'origin',
  city: 'origin',
  district: 'origin',
};

/** Null when the ship-to has no state (the caller then charges no tax and warns `no_ship_to`). */
export function decideSourcing(input: {
  shipFrom: PostalAddress | null | undefined;
  shipTo: PostalAddress | null | undefined;
  direction?: 'sales' | 'use';
}): SourcingDecision | null {
  const taxingState = stateCodeOf(input.shipTo);
  if (!taxingState) return null;

  const fromState = stateCodeOf(input.shipFrom);
  const interstate = !fromState || fromState !== taxingState;
  const destination: SourcingDecision = {
    sourcing: 'destination',
    taxingState,
    interstate,
    levelSource: ALL_DESTINATION,
  };

  if (input.direction === 'use' || interstate) return destination;

  switch (getUsState(taxingState)?.intrastateSourcing) {
    case 'origin':
      return { sourcing: 'origin', taxingState, interstate, levelSource: ALL_ORIGIN };
    case 'modified_origin':
      return {
        sourcing: 'modified_origin',
        taxingState,
        interstate,
        levelSource: { ...ALL_ORIGIN, district: 'destination' },
      };
    default:
      return destination;
  }
}

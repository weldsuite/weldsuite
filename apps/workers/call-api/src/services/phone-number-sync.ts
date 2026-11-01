/**
 * Which Telnyx numbers a workspace may pull in with "Sync numbers".
 *
 * Every workspace's numbers live on the one shared Telnyx account, so a
 * provider listing is never proof of ownership. The master
 * phone_number_registry is: it decides where inbound calls go. A number
 * belongs to the calling workspace when the registry assigns it to that
 * workspace, or, for a number with no registry row yet, when its Telnyx
 * customer_reference is one of the workspace's own voip_phone_numbers ids
 * (number orders set it to that id). Anything else belongs to someone else
 * or to nobody, and is skipped.
 */

import { normalizeE164 } from '../lib/phone-registry';

export interface ProviderPhoneNumber {
  id: string;
  phone_number: string;
  connection_id?: string | null;
  customer_reference?: string | null;
}

export interface RegistryOwner {
  phoneNumber: string;
  clerkOrgId: string;
}

export function selectOwnedProviderNumbers<T extends ProviderPhoneNumber>(args: {
  providerNumbers: T[];
  registry: RegistryOwner[];
  tenantNumberIds: string[];
  clerkOrgId: string;
}): { owned: T[]; skipped: number } {
  const ownerByNumber = new Map(
    args.registry.map((row) => [normalizeE164(row.phoneNumber), row.clerkOrgId]),
  );
  const tenantIds = new Set(args.tenantNumberIds);

  const owned: T[] = [];
  for (const number of args.providerNumbers) {
    if (!number.phone_number) continue;
    const owner = ownerByNumber.get(normalizeE164(number.phone_number));
    const isOwned = owner !== undefined
      ? owner === args.clerkOrgId
      : !!number.customer_reference && tenantIds.has(number.customer_reference);
    if (isOwned) owned.push(number);
  }
  return { owned, skipped: args.providerNumbers.length - owned.length };
}

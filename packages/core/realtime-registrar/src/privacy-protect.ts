import { RealtimeRegistrarError } from './errors';
import { normalizeTld } from './pricelist';
import { WELDHOST_PRIVACY_PROTECT } from './platform-contacts';

/**
 * TLDs whose registries reject Realtime Register `privacyProtect=true`.
 * DENIC (.de) was confirmed in production: registration fails with
 * "Privacy protect is not supported". Most ccTLDs behave the same;
 * the register/transfer client also retries without the flag if RTR
 * still refuses, so this set is a fast path rather than a complete list.
 *
 * @see https://dm.realtimeregister.com/docs/api/tlds/info `featuresAvailable.PRIVACY_PROTECT`
 */
const PRIVACY_PROTECT_UNSUPPORTED_TLDS = new Set([
  'de',
]);

/** True when this domain/TLD can be registered with RTR privacy protect. */
export function tldSupportsPrivacyProtect(domainOrTld: string): boolean {
  const normalized = normalizeTld(domainOrTld);
  if (!normalized) return true;
  const labels = normalized.split('.').filter(Boolean);
  for (let i = 0; i < labels.length; i++) {
    if (PRIVACY_PROTECT_UNSUPPORTED_TLDS.has(labels.slice(i).join('.'))) {
      return false;
    }
  }
  return true;
}

/**
 * WeldHost requests WHOIS/RDAP privacy whenever the TLD allows it, so
 * platform staff handles are not published. TLDs that reject the flag
 * (e.g. .de) register without it instead of failing the paid checkout.
 */
export function privacyProtectForDomain(domainOrTld: string): boolean {
  return WELDHOST_PRIVACY_PROTECT && tldSupportsPrivacyProtect(domainOrTld);
}

export function isPrivacyProtectUnsupportedError(err: unknown): boolean {
  if (!(err instanceof RealtimeRegistrarError)) return false;
  const haystack = `${err.code} ${err.message}`.toLowerCase();
  return /privacy\s*protect(ion)?/.test(haystack) && /not supported/.test(haystack);
}

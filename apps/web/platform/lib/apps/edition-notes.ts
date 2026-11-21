/**
 * What an app's store listing promises that this deployment doesn't offer.
 *
 * The App Store copy (`app_catalog`, seeded from `apps/web/admin/lib/apps-seed-data.ts`)
 * is one text for every edition, and it describes Global: WeldMeet's AI notes
 * and recordings, WeldHost's domain checkout, buying numbers in WeldCall, …
 * On an edition without one of those features (`unavailableFeatures` in
 * `/config.json`, `lib/edition.ts`) the app page names them under the
 * overview, so the listing never promises what the install can't do.
 */

import { isFeatureAvailable, type EditionFeature } from '@/lib/edition';

/** Features named in each first-party app's listing, by app code. */
const LISTED_FEATURES: Readonly<Record<string, readonly EditionFeature[]>> = {
  weldmeet: ['meet-recordings', 'meet-transcription'],
  weldhost: ['domain-purchase'],
  welddesk: ['agent-ai', 'desk-ai'],
  weldpanel: ['panel-analytics'],
  weldcall: ['phone-number-purchase'],
  weldreach: ['domain-purchase'],
  weldmail: ['mail-ai'],
  weldforms: ['forms-ai'],
  weldconnect: ['weldconnect-ai'],
  weldbooks: ['books-ocr', 'vat-digipoort'],
  weldhr: ['payroll-digipoort'],
};

/** The features `appCode`'s listing describes that this deployment lacks (none on Global). */
export function unavailableListedFeatures(appCode: string): EditionFeature[] {
  return (LISTED_FEATURES[appCode.trim().toLowerCase()] ?? []).filter((feature) => !isFeatureAvailable(feature));
}

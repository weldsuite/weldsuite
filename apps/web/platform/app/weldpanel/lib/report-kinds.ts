/** The name of a report kind in the UI; a kind this build has no name for shows as it is. */

import type { TranslationsType } from '@/lib/i18n/types';

export function reportKindLabel(t: TranslationsType, kind: string): string {
  const kinds: Readonly<Record<string, string>> = t.weldpanel.analytics.kinds;
  return kinds[kind] ?? kind;
}

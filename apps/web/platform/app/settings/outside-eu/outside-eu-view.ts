import type { OutsideEuService, OutsideEuUse } from '@weldsuite/app-api-client/schemas/outside-eu-services';
import type { TranslationNamespaces } from '@/lib/i18n';

/** `settings.outsideEu`. */
export type OutsideEuStrings = TranslationNamespaces['settings']['outsideEu'];

/** `{name}` placeholders filled in. */
export function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replaceAll(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** The country's name; the code itself for one this build doesn't name. */
export function countryName(strings: OutsideEuStrings, code: string): string {
  return (strings.countries as Record<string, string>)[code] ?? code;
}

/** What leaves the EU, translated; the backend's English for a service this build doesn't know. */
export function serviceData(strings: OutsideEuStrings, service: OutsideEuService): string {
  return (strings.data as Record<string, string>)[service.id] ?? service.data;
}

/** What uses the service, translated; the backend's English for an unknown key. */
export function labelOfUse(strings: OutsideEuStrings, use: OutsideEuUse): string {
  return (strings.uses as Record<string, string>)[use.key] ?? use.label;
}

/** "Switched on by … on …", by who switched it on; null while it is off. */
export function switchedOnText(
  strings: OutsideEuStrings,
  service: OutsideEuService,
  formatDate: (iso: string) => string,
): string | null {
  if (!service.enabled || !service.enabledAt) return null;
  const date = formatDate(service.enabledAt);
  if (service.via === 'move') return fill(strings.enabledByMove, { date });
  if (service.via === 'staff') return fill(strings.enabledByStaff, { date });
  const user = service.enabledByName ?? service.enabledBy;
  return user ? fill(strings.enabledBy, { user, date }) : null;
}

/** The services in their two groups: WeldSuite's account first, then what the workspace connects. */
export function groupServices(services: readonly OutsideEuService[]): {
  weldsuite: OutsideEuService[];
  workspace: OutsideEuService[];
} {
  return {
    weldsuite: services.filter((s) => s.account === 'weldsuite'),
    workspace: services.filter((s) => s.account === 'workspace'),
  };
}

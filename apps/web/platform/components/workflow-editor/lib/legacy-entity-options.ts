/**
 * An existing trigger can point at an entity type or event the picker no longer
 * offers (`lead`, `commerce_order`, ... after the catalog was trimmed). The
 * selects keep such a value visible and selectable as an extra "(legacy)"
 * option, so they never render blank and saving does not wipe it.
 */

interface EntityOption {
  entityType: string;
  label?: string;
  events: ReadonlyArray<string | { id: string }>;
}

export interface LegacyOption {
  value: string;
  label: string;
}

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `template` is the translated `{name} (legacy)` string. */
export function getLegacyEntityOption(
  entityType: string,
  entities: ReadonlyArray<EntityOption>,
  template: string,
): LegacyOption | null {
  if (!entityType || entities.some((entity) => entity.entityType === entityType)) return null;
  return { value: entityType, label: template.replace('{name}', humanize(entityType)) };
}

export function getLegacyEventOption(
  entityType: string,
  eventType: string,
  entities: ReadonlyArray<EntityOption>,
  template: string,
): LegacyOption | null {
  if (!eventType) return null;
  const offered = entities.find((entity) => entity.entityType === entityType)?.events ?? [];
  const known = offered.some((event) => (typeof event === 'string' ? event : event.id) === eventType);
  return known ? null : { value: eventType, label: template.replace('{name}', humanize(eventType)) };
}

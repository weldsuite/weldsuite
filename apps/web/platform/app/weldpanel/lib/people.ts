/** How a visitor or a person is named across the people, recordings and live pages. */

import type { PanelPersonDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';

/** The name to show for a profile: name, else email, else user id. */
export function personDisplayName(person: Pick<PanelPersonDto, 'name' | 'email' | 'userId'>): string {
  return person.name?.trim() || person.email?.trim() || person.userId;
}

/** "Anonymous visitor 4f2a9c" for an id the visitor never identified with; the user id otherwise. */
export function visitorLabel(row: Pick<PanelSessionRow, 'userId' | 'distinctId'>, anonymous: string): string {
  if (row.userId) return row.userId;
  return `${anonymous} ${row.distinctId.replace(/[^A-Za-z0-9]/g, '').slice(-6)}`;
}

export type SignalKey = 'rage' | 'dead' | 'quickback' | 'scroll' | 'errors';

/** The frustration counts of a session that are above zero, in a fixed order. */
export function sessionSignals(row: Pick<PanelSessionRow, 'rageClicks' | 'deadClicks' | 'quickBacks' | 'excessiveScrolls' | 'errors'>): { key: SignalKey; count: number }[] {
  const all: { key: SignalKey; count: number }[] = [
    { key: 'rage', count: row.rageClicks },
    { key: 'dead', count: row.deadClicks },
    { key: 'quickback', count: row.quickBacks },
    { key: 'scroll', count: row.excessiveScrolls },
    { key: 'errors', count: row.errors },
  ];
  return all.filter((s) => s.count > 0);
}

/** A property value as text for the profile's list. */
export function propertyText(value: string | number | boolean | null): string {
  if (value === null) return '';
  return String(value);
}

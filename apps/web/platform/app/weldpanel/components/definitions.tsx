/**
 * The project's data definitions for the report builders: custom events
 * (`@pnce_…`, offered next to tracked events), computed properties
 * (`@pncp_…`, offered next to event properties) and group types (group
 * filters, group breakdowns and "count by").
 *
 * A builder wraps itself in `PanelDefinitionsProvider`; pickers and the filter
 * and breakdown builders read the context. Without a provider (the cohort
 * editor, the recordings filters) they behave as before: plain names only,
 * which is also what those specs accept.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PanelComputedPropertyDto, PanelCustomEventDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelGroupTypeDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { isComputedPropertyRef, isCustomEventRef } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { useWeldPanelComputedProperties, useWeldPanelCustomEvents, useWeldPanelGroupTypes } from '@/hooks/queries/use-weldpanel-analysis-queries';

export interface PanelDefinitions {
  /** A provider is mounted: custom events, computed properties and groups may be offered. */
  enabled: boolean;
  customEvents: PanelCustomEventDto[];
  computedProperties: PanelComputedPropertyDto[];
  /** Group types the project collects or configured. */
  groupTypes: PanelGroupTypeDto[];
}

const EMPTY: PanelDefinitions = { enabled: false, customEvents: [], computedProperties: [], groupTypes: [] };

const DefinitionsContext = createContext<PanelDefinitions>(EMPTY);

export function PanelDefinitionsProvider({ projectId, children }: Readonly<{ projectId: string; children: ReactNode }>) {
  const { data: customEvents } = useWeldPanelCustomEvents(projectId);
  const { data: computedProperties } = useWeldPanelComputedProperties(projectId);
  const { data: groupTypes } = useWeldPanelGroupTypes(projectId);
  const value = useMemo<PanelDefinitions>(
    () => ({ enabled: true, customEvents: customEvents ?? [], computedProperties: computedProperties ?? [], groupTypes: groupTypes ?? [] }),
    [customEvents, computedProperties, groupTypes],
  );
  return <DefinitionsContext.Provider value={value}>{children}</DefinitionsContext.Provider>;
}

export function usePanelDefinitions(): PanelDefinitions {
  return useContext(DefinitionsContext);
}

/** What to show for an event in a spec: a custom event's name, else the name itself. */
export function eventLabel(definitions: PanelDefinitions, event: string): string {
  if (!isCustomEventRef(event)) return event;
  return definitions.customEvents.find((e) => e.ref === event)?.name ?? event;
}

/** What to show for an event property in a spec: a computed property's name, else the key. */
export function propertyLabel(definitions: PanelDefinitions, key: string): string {
  if (!isComputedPropertyRef(key)) return key;
  return definitions.computedProperties.find((p) => p.ref === key)?.name ?? key;
}

/** A group type's plural name (`Companies`), else the type. */
export function groupTypeLabel(definitions: PanelDefinitions, groupType: string, form: 'singular' | 'plural' = 'plural'): string {
  const type = definitions.groupTypes.find((g) => g.groupType === groupType);
  if (!type) return groupType;
  return form === 'plural' ? type.namePlural : type.nameSingular;
}

/** Bound versions of the label helpers for the current context. */
export function useDefinitionLabels() {
  const definitions = usePanelDefinitions();
  return useMemo(
    () => ({
      event: (event: string) => eventLabel(definitions, event),
      property: (key: string) => propertyLabel(definitions, key),
      groupType: (groupType: string, form: 'singular' | 'plural' = 'plural') => groupTypeLabel(definitions, groupType, form),
    }),
    [definitions],
  );
}

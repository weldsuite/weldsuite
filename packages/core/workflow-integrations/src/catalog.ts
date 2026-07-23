/**
 * Catalog derivations — flatten the provider registry into the flat
 * action/trigger shapes the WeldConnect builder pickers already render.
 * Imported by app-api's `static-catalogs.ts` and concatenated into the
 * existing `ACTION_TYPES` / `TRIGGER_TYPES` arrays.
 */

import { listIntegrations } from './registry';

export interface CatalogActionType {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  provider: string;
  inputs: ReturnType<typeof actionInputs>;
}

function actionInputs(inputs: { key: string; label: string; type: string; required?: boolean }[]) {
  return inputs;
}

/** Namespaced integration actions for the builder's action picker. */
export function deriveActionTypes(): CatalogActionType[] {
  return listIntegrations().flatMap((def) =>
    def.actions.map((a) => ({
      id: a.id,
      name: `${def.label}: ${a.name}`,
      description: a.description,
      category: 'integration',
      icon: def.icon,
      provider: def.id,
      inputs: a.inputs,
    })),
  );
}

export interface CatalogTriggerType {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  provider: string;
  kind: 'webhook' | 'poll';
  outputFields: string[];
}

/** Namespaced integration triggers for the builder's trigger picker. These
 *  map onto `integration_event` workflow triggers (`{ provider, event }`). */
export function deriveIntegrationTriggerTypes(): CatalogTriggerType[] {
  return listIntegrations().flatMap((def) =>
    def.triggers.map((t) => ({
      id: t.id,
      name: `${def.label}: ${t.name}`,
      description: t.description,
      category: 'integration',
      icon: def.icon,
      provider: def.id,
      kind: t.kind,
      outputFields: t.outputFields ?? [],
    })),
  );
}

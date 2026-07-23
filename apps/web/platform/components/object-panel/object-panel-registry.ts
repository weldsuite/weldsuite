import type { ObjectPanelDefinition, ObjectType } from './types';

const registry = new Map<ObjectType, ObjectPanelDefinition>();

/**
 * Register a panel for an object type. Call this at module-load time from
 * each object's `index.ts` so every panel is wired before `<ObjectPanelHost />`
 * tries to render.
 */
export function registerObjectPanel(definition: ObjectPanelDefinition): void {
  registry.set(definition.type, definition);
}

export function resolveObjectPanel(type: ObjectType): ObjectPanelDefinition | undefined {
  return registry.get(type);
}

function listRegisteredPanels(): ObjectPanelDefinition[] {
  return [...registry.values()];
}

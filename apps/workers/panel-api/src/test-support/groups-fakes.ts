/**
 * The PanelProject Durable Object's group side, for the group and group-type
 * route tests: slots for group types (at most `maxTypes`, taken in order),
 * group profiles, and what the query context reads (erased ids, the identity
 * flag). Records which project's object was asked and what it was asked.
 */

import type { PanelGroup, PanelGroupsPage } from '@weldsuite/panel-domain/project-object';

export function group(groupType: string, groupKey: string, extra: Partial<PanelGroup> = {}): PanelGroup {
  return {
    groupType,
    groupKey,
    properties: {},
    firstSeen: '2026-11-01T10:00:00.000Z',
    lastSeen: '2026-11-14T10:00:00.000Z',
    ...extra,
  };
}

export class FakeGroupState {
  /** The types holding a slot, in the order they were taken. */
  types: string[] = [];
  groups: PanelGroup[] = [];
  erased: string[] = [];
  identified = false;
  maxTypes = 5;
  /** The project ids whose object was asked for. */
  objects: string[] = [];
  ensureCalls: string[][] = [];
  released: string[] = [];
  deleteCalls: { workspaceId: string; projectId: string; groupType: string; groupKey: string }[] = [];

  reset(): void {
    this.types = [];
    this.groups = [];
    this.erased = [];
    this.identified = false;
    this.maxTypes = 5;
    this.objects = [];
    this.ensureCalls = [];
    this.released = [];
    this.deleteCalls = [];
  }

  /** A Durable Object namespace whose object (for every project) is this state. */
  namespace() {
    const state = this;
    const stub = {
      erasedIds: async () => state.erased,
      hasIdentifiedUsers: async () => state.identified,
      groupTypes: async () => [...state.types],
      ensureGroupTypes: async (types: string[]) => {
        state.ensureCalls.push(types);
        for (const type of types) {
          if (!state.types.includes(type) && state.types.length < state.maxTypes) state.types.push(type);
        }
        return [...state.types];
      },
      releaseGroupType: async (groupType: string) => {
        state.released.push(groupType);
        state.types = state.types.filter((t) => t !== groupType);
      },
      getGroup: async (groupType: string, groupKey: string) =>
        state.groups.find((g) => g.groupType === groupType && g.groupKey === groupKey) ?? null,
      listGroups: async (input: { groupType: string; search?: string; cursor?: string | null; limit: number }): Promise<PanelGroupsPage> => {
        const needle = input.search?.toLowerCase();
        const all = state.groups
          .filter((g) => g.groupType === input.groupType)
          .filter((g) => {
            if (!needle) return true;
            return [g.groupKey, g.properties.$name, g.properties.name].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
          })
          .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
        const start = input.cursor ? Number(input.cursor) : 0;
        const next = start + input.limit;
        return { groups: all.slice(start, next), cursor: next < all.length ? String(next) : null, totalCount: all.length };
      },
      deleteGroup: async (input: { workspaceId: string; projectId: string; groupType: string; groupKey: string }) => {
        state.deleteCalls.push(input);
        const before = state.groups.length;
        state.groups = state.groups.filter((g) => !(g.groupType === input.groupType && g.groupKey === input.groupKey));
        return state.groups.length < before;
      },
    };
    return {
      idFromName: (name: string) => {
        state.objects.push(name);
        return name as unknown as DurableObjectId;
      },
      get: () => stub,
    };
  }
}

/**
 * What every row, menu and bar of the Backlog shares: the project's item
 * types, its sprints and epics, the selection and the actions on items. The
 * page owns the state; the parts read it from here.
 */

import { createContext, useContext } from 'react';
import type { EpicRollup, ItemType, ItemTypeNaming, Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';

export interface BacklogActions {
  open: (id: string) => void;
  changeType: (ids: string[], type: ItemType) => void;
  /** `null` takes the items out of their sprint, back to the backlog. */
  moveToSprint: (ids: string[], sprintId: string | null) => void;
  setEpic: (ids: string[], epicId: string | null) => void;
  turnIntoEpic: (id: string) => void;
  requestDelete: (ids: string[]) => void;
}

export interface BacklogEnv {
  projectId: string;
  canWrite: boolean;
  naming: ItemTypeNaming;
  featureLevel: boolean;
  usesSprints: boolean;
  /** The types an item can be changed to. */
  types: ItemType[];
  /** The planned and active sprints: where an item can be planned. */
  sprints: Sprint[];
  epics: EpicRollup[];
  epicsById: ReadonlyMap<string, EpicRollup>;
  selected: ReadonlySet<string>;
  toggleSelected: (id: string) => void;
  /** The items an action on `id` applies to: the whole selection when `id` is part of it. */
  targetsFor: (id: string) => string[];
  actions: BacklogActions;
}

const BacklogEnvContext = createContext<BacklogEnv | null>(null);

export const BacklogEnvProvider = BacklogEnvContext.Provider;

export function useBacklogEnv(): BacklogEnv {
  const env = useContext(BacklogEnvContext);
  if (!env) throw new Error('useBacklogEnv must be used inside the Backlog page');
  return env;
}

import { createContext, useContext } from 'react';
import type { RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';

/** What the signed-in member may do in this project's register. */
export interface RaidAbilities {
  /** Create items (project write access and `projects:create`). */
  create: boolean;
  /** Edit, reassess, convert and link (project write access and `projects:update`). */
  update: boolean;
  /** Delete items (project write access and `projects:delete`). */
  remove: boolean;
  /** Create mitigation and resolution tasks (`update` and `tasks:create`). */
  createTasks: boolean;
  /** Check linked tasks off (`update` and `tasks:update`). */
  updateTasks: boolean;
}

export interface RaidMember {
  userId: string;
  name: string;
  email: string | null;
  avatar: string | null;
}

export interface RaidContextValue {
  projectId: string;
  projectName: string;
  /** Every item of the project, all kinds, open and closed. */
  items: RaidItem[];
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
  /** Today; it changes only with the calendar day, so every "overdue" on a screen agrees. */
  now: Date;
  members: RaidMember[];
  /** The member with this user id, if the project has one. */
  memberOf: (userId: string | null) => RaidMember | null;
  abilities: RaidAbilities;
  selectedId: string | null;
  select: (id: string | null) => void;
  openCreate: (kind: RaidKind) => void;
  openEdit: (item: RaidItem) => void;
}

export const RaidContext = createContext<RaidContextValue | null>(null);

export function useRaid(): RaidContextValue {
  const value = useContext(RaidContext);
  if (!value) throw new Error('useRaid must be used within the RAID layout');
  return value;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isSameDay } from 'date-fns';
import { usePermissions } from '@weldsuite/permissions/react';
import type { RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { useProjectMembers } from '@/hooks/queries/use-projects-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import type { RegisterFilters } from '../_lib/raid';

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
  /** Change the workspace's risk categories (`portfolio:manage`; not tied to this project). */
  manageCategories: boolean;
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
  /** The sub-tab on screen; the toolbar above the sub-tab pages belongs to it. */
  activeKind: RaidKind;
  /** The toolbar's search and filters for the sub-tab on screen (each sub-tab keeps its own). */
  filters: RegisterFilters;
  setFilters: (filters: RegisterFilters) => void;
  /** Whether closed items are listed on the sub-tab on screen. */
  showClosed: boolean;
  toggleShowClosed: () => void;
}

export const RaidContext = createContext<RaidContextValue | null>(null);

export function useRaid(): RaidContextValue {
  const value = useContext(RaidContext);
  if (!value) throw new Error('useRaid must be used within the RAID layout');
  return value;
}

// ── Building a context: shared by the RAID tab and the RAID item panel ───────

/**
 * Today, as a stable value: every "overdue" and "in 3 days" on a screen is
 * worked out from it, and it moves on only when the calendar day changes.
 */
export function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setToday((previous) => (isSameDay(previous, new Date()) ? previous : new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return today;
}

/** What the member may do, from the project grants (needs a `ProjectPermissionProvider`). */
export function useRaidAbilities(): RaidAbilities {
  const { canWrite } = useProjectPermissions();
  const { can } = usePermissions();
  const update = canWrite && can('projects:update');
  return {
    create: canWrite && can('projects:create'),
    update,
    remove: canWrite && can('projects:delete'),
    createTasks: update && can('tasks:create'),
    updateTasks: update && can('tasks:update'),
    manageCategories: can('portfolio:manage'),
  };
}

/** The active members of a project, by name, and a lookup by user id. */
export function useRaidMembers(projectId: string): Pick<RaidContextValue, 'members' | 'memberOf'> {
  const membersQuery = useProjectMembers(projectId);
  const members = useMemo<RaidMember[]>(
    () =>
      (membersQuery.data?.data ?? [])
        .filter((member) => member.isActive !== false && !member.leftAt)
        .map((member) => ({
          userId: member.userId,
          name: member.user?.name || member.user?.email || member.userId,
          email: member.user?.email ?? null,
          avatar: member.user?.avatar ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [membersQuery.data],
  );
  const memberById = useMemo(() => new Map(members.map((member) => [member.userId, member])), [members]);
  const memberOf = useCallback((userId: string | null) => (userId ? (memberById.get(userId) ?? null) : null), [memberById]);
  return { members, memberOf };
}

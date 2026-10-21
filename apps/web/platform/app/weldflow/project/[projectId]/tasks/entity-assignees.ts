/**
 * Assignee directory for the CRM customer/person Tasks tab.
 *
 * That board has no single project, so it cannot load project members. The
 * picker must list workspace members (so a brand-new customer still has people
 * to assign) and keep anyone already on a task who is no longer in that
 * directory, so their name still renders. Those are marked `departed`: pickers
 * show them only on a task they are already on, so they can be unassigned but
 * never newly picked.
 */

export interface EntityAssigneeDirectoryMember {
  userId: string;
  user: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
  departed?: boolean;
}

interface WorkspaceMemberSource {
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
}

interface TaskAssigneeSource {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
}

interface TaskAssigneeFields {
  assignees?: readonly TaskAssigneeSource[] | null;
  assigneeId?: string | null;
  assignee?: string | null;
}

export function buildEntityAssigneeDirectory(
  workspaceMembers: readonly WorkspaceMemberSource[],
  tasks: readonly TaskAssigneeFields[],
): EntityAssigneeDirectoryMember[] {
  const seen = new Map<string, EntityAssigneeDirectoryMember>();

  for (const member of workspaceMembers) {
    if (!member.userId || !member.name) continue;
    seen.set(member.userId, {
      userId: member.userId,
      user: {
        id: member.userId,
        name: member.name,
        email: member.email ?? '',
        avatar: member.picture || undefined,
      },
    });
  }

  for (const task of tasks) {
    for (const assignee of task.assignees ?? []) {
      if (!assignee.id || !assignee.name || seen.has(assignee.id)) continue;
      seen.set(assignee.id, {
        userId: assignee.id,
        user: {
          id: assignee.id,
          name: assignee.name,
          email: assignee.email ?? '',
          avatar: assignee.avatar,
        },
        departed: true,
      });
    }
    if (task.assigneeId && task.assignee && !seen.has(task.assigneeId)) {
      seen.set(task.assigneeId, {
        userId: task.assigneeId,
        user: { id: task.assigneeId, name: task.assignee, email: '' },
        departed: true,
      });
    }
  }

  return Array.from(seen.values());
}

/** May a picker offer this person? Departed ones only while already selected. */
export function isPickableAssignee(
  member: { departed?: boolean },
  isSelected: boolean,
): boolean {
  return !member.departed || isSelected;
}

/**
 * Assignee directory for the CRM customer/person Tasks tab.
 *
 * That board has no single project, so it cannot load project members. The
 * picker must list workspace members (so a brand-new customer still has people
 * to assign) and keep anyone already on a task who is no longer in that
 * directory, so their name still renders.
 */

export interface EntityAssigneeDirectoryMember {
  userId: string;
  user: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
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
      });
    }
    if (task.assigneeId && task.assignee && !seen.has(task.assigneeId)) {
      seen.set(task.assigneeId, {
        userId: task.assigneeId,
        user: { id: task.assigneeId, name: task.assignee, email: '' },
      });
    }
  }

  return Array.from(seen.values());
}

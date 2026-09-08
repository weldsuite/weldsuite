/**
 * Resolve a human-readable assignee label from API-enriched task fields
 * and/or project member directory. Never prefer a raw Clerk user id when
 * a name or email is available.
 */

export type TaskAssigneeRef = {
  id: string;
  name: string | null;
  email?: string | null;
  avatar?: string | null;
};

export type AssigneeMemberRef = {
  userId: string;
  user: {
    name: string | null;
    email: string | null;
  } | null;
};

export type TaskAssigneeSource = {
  assignee?: TaskAssigneeRef | null;
  assignees?: TaskAssigneeRef[] | null;
  assigneeId?: string | null;
  assigneeIds?: string[] | null;
};

function personLabel(person: {
  name?: string | null;
  email?: string | null;
  id?: string;
}): string {
  return person.name || person.email || person.id || '';
}

function assigneeIds(task: TaskAssigneeSource): string[] {
  if (Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0) {
    return task.assigneeIds;
  }
  if (task.assigneeId) return [task.assigneeId];
  return [];
}

/**
 * Returns a display string for the task's assignee(s), or `null` when unassigned.
 */
export function formatTaskAssigneeDisplay(
  task: TaskAssigneeSource,
  members?: AssigneeMemberRef[],
): string | null {
  const enriched =
    Array.isArray(task.assignees) && task.assignees.length > 0
      ? task.assignees
      : task.assignee
        ? [task.assignee]
        : [];

  if (enriched.length > 0) {
    const labels = enriched.map((a) => personLabel(a)).filter(Boolean);
    return labels.length > 0 ? labels.join(', ') : null;
  }

  const ids = assigneeIds(task);
  if (ids.length === 0) return null;

  if (members && members.length > 0) {
    return ids
      .map((id) => {
        const member = members.find((m) => m.userId === id);
        return personLabel({
          name: member?.user?.name,
          email: member?.user?.email,
          id,
        });
      })
      .join(', ');
  }

  // Last resort — API enrichment and members unavailable.
  return ids.join(', ');
}

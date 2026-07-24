
import { useMemo } from 'react';
import { useUser } from '@clerk/clerk-react';
import { NotesView } from '@/components/weldcrm/notes/notes-view';
import { useNotes } from '@/hooks/queries/use-notes-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { PageLoader } from '@/components/page-loader';

type RecordKind = 'company' | 'person';

interface NoteActivity {
  id: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  isFavorite?: boolean;
  contactId?: string;
  contactAvatarUrl?: string;
  customerId?: string;
  customerAvatarUrl?: string;
  relatedTo?: string;
  relatedToId?: string;
  relatedToName?: string;
  assignedToId?: string;
  createdBy?: string;
  assignedTo?: string;
}

interface WorkspaceMemberInfo {
  id?: string;
  userId?: string;
  name?: string;
  picture?: string;
}

function resolveRecord(activity: NoteActivity): {
  kind?: RecordKind;
  id?: string;
  avatar?: string;
} {
  if (activity.contactId) {
    return {
      kind: 'person',
      id: activity.contactId,
      avatar: activity.contactAvatarUrl,
    };
  }
  if (activity.customerId) {
    return {
      kind: 'company',
      id: activity.customerId,
      avatar: activity.customerAvatarUrl,
    };
  }
  if (activity.relatedTo === 'person' || activity.relatedTo === 'contact') {
    return { kind: 'person', id: activity.relatedToId, avatar: activity.contactAvatarUrl };
  }
  if (activity.relatedTo === 'company' || activity.relatedTo === 'customer') {
    return { kind: 'company', id: activity.relatedToId, avatar: activity.customerAvatarUrl };
  }
  return {};
}

export default function NotesPage() {
  const { user } = useUser();
  const { data, isLoading } = useNotes({ limit: 100 });
  const { data: membersData } = useWorkspaceMembers(1, 100);

  // Lookup by Clerk user ID. Falls back to workspace_members row ID for
  // the few legacy activities that were written with the row id instead.
  const memberById = useMemo(() => {
    const map = new Map<string, { name?: string; picture?: string }>();
    (membersData?.data || []).forEach((m: WorkspaceMemberInfo) => {
      const info = { name: m.name, picture: m.picture };
      if (m.userId) map.set(m.userId, info);
      if (m.id) map.set(m.id, info);
    });
    return map;
  }, [membersData]);

  const notes = useMemo(() => {
    if (!data?.data) return [];
    // Best-effort author resolution for the current Clerk user. Lets
    // self-authored notes render correctly even when the workspace_members
    // fetch is empty (e.g. user lacks team:read or hasn't been synced yet).
    const currentUserName =
      user?.fullName ||
      user?.firstName ||
      user?.primaryEmailAddress?.emailAddress ||
      undefined;
    const currentUserAvatar = user?.imageUrl || undefined;

    return (data.data as NoteActivity[]).map((activity) => {
      const authorId = activity.assignedToId || activity.createdBy;
      const isCurrentUser = !!user?.id && authorId === user.id;
      const member = authorId ? memberById.get(authorId) : undefined;
      const record = resolveRecord(activity);

      const authorName = isCurrentUser
        ? currentUserName ?? member?.name
        : member?.name ?? activity.assignedTo ?? undefined;
      const authorAvatar = isCurrentUser
        ? currentUserAvatar ?? member?.picture
        : member?.picture ?? undefined;

      return {
        id: activity.id,
        content: activity.description || '',
        createdAt: new Date(activity.createdAt),
        updatedAt: new Date(activity.updatedAt),
        isPinned: !!activity.isFavorite,
        recordKind: record.kind,
        recordId: record.id,
        recordName: activity.relatedToName,
        recordAvatar: record.avatar,
        authorName,
        authorAvatar,
      };
    });
  }, [data, memberById, user]);

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="h-full overflow-y-auto">
      <NotesView initialNotes={notes} />
    </div>
  );
}

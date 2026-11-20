import { MemberAvatar } from '@/components/member-avatar';

interface BookmarkAuthor {
  messageAuthorId?: string | null;
  messageAuthorName?: string | null;
  messageAuthorAvatar?: string | null;
}

/** The bookmarked message's author, with their current profile picture. */
export function BookmarkAuthorAvatar({ bookmark }: Readonly<{ bookmark: BookmarkAuthor }>) {
  return (
    <MemberAvatar
      userId={bookmark.messageAuthorId}
      name={bookmark.messageAuthorName}
      picture={bookmark.messageAuthorAvatar}
      className="h-6 w-6"
      fallbackClassName="text-[10px]"
      fallback={(bookmark.messageAuthorName || '?')[0]?.toUpperCase()}
    />
  );
}

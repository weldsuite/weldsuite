import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const avatar = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('@/hooks/use-member-avatar', () => ({ useMemberAvatar: avatar.resolve }));
// jsdom never loads images, so Radix would only ever show the fallback; plain
// elements let the test see which picture the avatar asked for.
vi.mock('@weldsuite/ui/components/avatar', () => ({
  Avatar: ({ children, className, title }: { children: ReactNode; className?: string; title?: string }) => (
    <div data-testid="avatar" className={className} title={title}>
      {children}
    </div>
  ),
  AvatarImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  AvatarFallback: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span data-testid="fallback" className={className}>
      {children}
    </span>
  ),
}));

import { MemberAvatar, memberInitials } from './member-avatar';
import { CommentAuthorAvatar } from './record-comments/comment-parts';
import { BookmarkAuthorAvatar } from '@/app/weldchat/components/bookmark-author-avatar';

beforeEach(() => {
  avatar.resolve.mockReset();
});

describe('memberInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(memberInitials('ada byron lovelace')).toBe('AB');
    expect(memberInitials('  Grace  ')).toBe('G');
  });

  it('falls back to a question mark without a name', () => {
    expect(memberInitials('')).toBe('?');
    expect(memberInitials(null)).toBe('?');
  });
});

describe('MemberAvatar', () => {
  it('shows the picture the member resolves to, by user id', () => {
    avatar.resolve.mockReturnValue('https://cdn.test/avatars/ada.png');
    render(<MemberAvatar userId="user_ada" name="Ada Lovelace" picture="https://cdn.test/old.png" alt="Ada" className="size-6" />);

    expect(avatar.resolve).toHaveBeenCalledWith('user_ada', 'https://cdn.test/old.png');
    expect(screen.getByRole('img', { name: 'Ada' })).toHaveAttribute('src', 'https://cdn.test/avatars/ada.png');
    expect(screen.getByTestId('fallback')).toHaveTextContent('AL');
    expect(screen.getByTestId('avatar')).toHaveClass('size-6');
  });

  it('shows only the initials when there is no picture', () => {
    avatar.resolve.mockReturnValue(undefined);
    render(<MemberAvatar userId="user_ada" name="Ada Lovelace" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTestId('fallback')).toHaveTextContent('AL');
  });

  it('uses the fallback it is given instead of the initials', () => {
    avatar.resolve.mockReturnValue(undefined);
    render(<MemberAvatar userId="user_ada" name="Ada Lovelace" fallback="A" fallbackClassName="text-xs" />);
    expect(screen.getByTestId('fallback')).toHaveTextContent(/^A$/);
    expect(screen.getByTestId('fallback')).toHaveClass('text-xs');
  });
});

describe('CommentAuthorAvatar', () => {
  it("resolves the comment author's current picture", () => {
    avatar.resolve.mockReturnValue('https://cdn.test/avatars/grace.png');
    render(
      <CommentAuthorAvatar
        message={{ authorId: 'user_grace', authorName: 'Grace Hopper', authorAvatar: 'https://cdn.test/old.png' }}
      />,
    );
    expect(avatar.resolve).toHaveBeenCalledWith('user_grace', 'https://cdn.test/old.png');
    expect(screen.getByTestId('fallback')).toHaveTextContent('GH');
  });
});

describe('BookmarkAuthorAvatar', () => {
  it("resolves the bookmarked message author's current picture", () => {
    avatar.resolve.mockReturnValue(undefined);
    render(
      <BookmarkAuthorAvatar
        bookmark={{ messageAuthorId: 'user_ada', messageAuthorName: 'ada', messageAuthorAvatar: null }}
      />,
    );
    expect(avatar.resolve).toHaveBeenCalledWith('user_ada', null);
    expect(screen.getByTestId('fallback')).toHaveTextContent(/^A$/);
  });

  it('shows a question mark for an unknown author', () => {
    avatar.resolve.mockReturnValue(undefined);
    render(<BookmarkAuthorAvatar bookmark={{}} />);
    expect(screen.getByTestId('fallback')).toHaveTextContent('?');
  });
});

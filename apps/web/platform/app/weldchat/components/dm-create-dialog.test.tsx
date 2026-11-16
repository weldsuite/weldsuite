import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  members: [] as Array<Record<string, string>>,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: state.members } }),
  useCreateDm: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        dmCreate: {
          title: 'New message',
          searchPeople: 'Search people...',
          noResults: 'No people found.',
          people: 'People',
          navigate: 'Navigate',
          startConversation: 'Start Conversation',
          creating: 'Creating...',
          invited: 'Invited',
        },
      },
    },
  }),
}));

import { DmCreateDialog } from './dm-create-dialog';

const ann = { id: 'mbr_ann', userId: 'user_ann', name: 'Ann', email: 'ann@example.com', status: 'ACTIVE' };
const bob = { id: 'mbr_bob', userId: 'invited_bob@example.com', name: 'Bob', email: 'bob@example.com', status: 'PENDING' };
const cat = { id: 'mbr_cat', userId: 'user_cat', name: 'Cat', email: 'cat@example.com', status: 'ACTIVE' };

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('[data-slot="command-item"]');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  state.navigate.mockReset();
  state.members = [bob, ann, cat];
});

describe('DmCreateDialog', () => {
  it('lists an invitee last, marked Invited and disabled', () => {
    render(<DmCreateDialog open onOpenChange={() => {}} />);

    const names = Array.from(document.querySelectorAll('[data-slot="command-item"] span.font-medium')).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['Ann', 'Cat', 'Bob']);

    const bobRow = rowOf('Bob');
    expect(bobRow.getAttribute('data-disabled')).toBe('true');
    expect(bobRow.textContent).toContain('Invited');
    // An invitee's email gives way to the label.
    expect(bobRow.textContent).not.toContain('bob@example.com');

    const annRow = rowOf('Ann');
    expect(annRow.getAttribute('data-disabled')).toBe('false');
    expect(annRow.textContent).not.toContain('Invited');
  });

  it("doesn't pick an invitee, and opens the DM with someone who joined", () => {
    render(<DmCreateDialog open onOpenChange={() => {}} />);

    fireEvent.click(rowOf('Bob'));
    fireEvent.click(rowOf('Cat'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Conversation' }));

    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/dm/$userId', params: { userId: 'user_cat' } });
  });
});

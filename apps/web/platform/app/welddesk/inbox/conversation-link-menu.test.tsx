/**
 * Merging from the conversation header: picking a ticket only asks, the merge
 * runs on the confirmation, and a refusal goes back to the picker.
 */

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));

interface MergeCallbacks {
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

const merge = vi.hoisted(() => ({
  mutate: vi.fn<(input: { id: string; targetId: string }, callbacks: MergeCallbacks) => void>(),
  isPending: false,
}));
const idle = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));

vi.mock('@/hooks/queries/use-desk-link-queries', () => ({
  deskLinkErrorMessage: () => null,
  deskLinkRefusal: (err: { reason?: string }) => err.reason ?? null,
  useCloseDeskIncident: () => idle,
  useDeskConversationLinks: () => ({ data: { children: [] } }),
  useMergeDeskConversation: () => merge,
  usePostDeskIncidentUpdate: () => idle,
  useSetDeskMajorIncident: () => idle,
}));

// The menu and the picker are not what is under test: an open trigger and one row.
vi.mock('./conversation-actions-menu', () => ({
  ConversationActionsMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));
vi.mock('./ticket-picker-dialog', () => ({
  TicketPickerDialog: ({
    open,
    notice,
    onPick,
  }: {
    open: boolean;
    notice?: ReactNode;
    onPick: (conversation: { id: string; conversationNumber: number }) => void;
  }) =>
    open ? (
      <div data-testid="picker">
        {notice}
        <button type="button" onClick={() => onPick({ id: 'dconv_kept', conversationNumber: 42 })}>
          pick #42
        </button>
      </div>
    ) : null,
}));

import { ConversationLinkMenu } from './conversation-link-menu';

const duplicate = { id: 'dconv_dup', conversationNumber: 7, state: 'open' } as never;

function pickTicket() {
  render(<ConversationLinkMenu conversation={duplicate} />);
  fireEvent.click(screen.getByText('Merge into another ticket'));
  fireEvent.click(screen.getByText('pick #42'));
}

beforeEach(() => {
  merge.mutate.mockReset();
});

describe('ConversationLinkMenu · merge', () => {
  it('asks before merging: picking a ticket merges nothing', () => {
    pickTicket();
    expect(merge.mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Merge this ticket into #42?')).toBeTruthy();
    expect(screen.queryByTestId('picker')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(merge.mutate).toHaveBeenCalledTimes(1);
    expect(merge.mutate.mock.calls[0]![0]).toEqual({ id: 'dconv_dup', targetId: 'dconv_kept' });
  });

  it('goes back to the picker with the reason when the merge is refused', () => {
    pickTicket();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    merge.mutate.mock.calls[0]![1].onError?.({ reason: 'different_customer' });

    // React flushes the state the callback set on the next read.
    return screen.findByTestId('picker').then((picker) => {
      expect(picker.textContent).toContain("can't be merged");
      expect(screen.queryByText('Merge this ticket into #42?')).toBeNull();
    });
  });
});

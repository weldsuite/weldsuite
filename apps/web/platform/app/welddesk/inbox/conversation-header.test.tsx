import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import { ConversationHeader } from './conversation-header';

const manage = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => undefined), isPending: false }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useUser: () => ({ user: { id: 'user_me' } }) }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('@/hooks/queries/use-desk-queries', () => ({ useManageDeskConversation: () => manage }));
vi.mock('@/hooks/queries/use-desk-workspace-members', () => ({
  useDeskWorkspaceMembers: () => ({ data: [{ userId: 'user_ann', name: 'Ann Smit' }] }),
}));
// The other actions have their own tests; this one is about the header's own.
vi.mock('./sla-badge', () => ({ DeskSlaBadge: () => null }));
vi.mock('./translation/translate-toggle', () => ({ TranslateLanguageBadge: () => null }));
vi.mock('./conversation-link-menu', () => ({ ConversationLinkMenu: () => null }));
vi.mock('./create-ticket-action', () => ({ CreateTicketAction: () => null }));
vi.mock('@/components/welddesk/phone/desk-call-button', () => ({ DeskCallButton: () => null }));

const th = en.deskInbox2.header;

function conversation(overrides: Partial<DeskConversation> = {}): DeskConversation {
  return { id: 'dconv_1', title: 'Order question', state: 'open', assigneeId: null, ...overrides } as DeskConversation;
}

afterEach(() => {
  cleanup();
  manage.mutateAsync.mockClear();
});

describe('ConversationHeader', () => {
  it('names its icon-only actions, so a narrow column still says what they do', () => {
    render(<ConversationHeader conversation={conversation()} />);

    // The desktop check icon and the phone's text button.
    expect(screen.getAllByRole('button', { name: th.close })).toHaveLength(2);
    expect(screen.getByRole('button', { name: th.assign })).toBeTruthy();
  });

  it('names the assignee on the assign button and offers to reopen a closed conversation', () => {
    render(<ConversationHeader conversation={conversation({ state: 'closed', assigneeId: 'user_ann' })} />);

    expect(screen.getByRole('button', { name: 'Ann Smit' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: th.reopen })).toHaveLength(2);
  });

  it('assigns the conversation to the agent with Assign to me, the first item of the Assign menu', () => {
    render(<ConversationHeader conversation={conversation()} />);

    // One Assign button: "Assign to me" is in its menu, not a button of its own.
    expect(screen.queryByRole('button', { name: th.assignToMe })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: th.assign }));
    fireEvent.click(screen.getByRole('option', { name: th.assignToMe }));

    expect(manage.mutateAsync).toHaveBeenCalledWith({
      id: 'dconv_1',
      data: { action: 'assign', assigneeId: 'user_me' },
    });
  });

  it('has no Assign to me when the agent already owns the conversation', () => {
    render(<ConversationHeader conversation={conversation({ assigneeId: 'user_me' })} />);

    // The members list doesn't hold the agent here, so the button still reads "Assign".
    fireEvent.click(screen.getByRole('button', { name: th.assign }));
    expect(screen.queryByRole('option', { name: th.assignToMe })).toBeNull();
  });
});

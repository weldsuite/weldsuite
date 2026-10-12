import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  messageFixture,
  renderWithApp,
  stubRadixBrowserApis,
  threadFixture,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  getThread: vi.fn(),
  updateMessage: vi.fn(),
  reply: vi.fn(),
  addToCrm: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
vi.mock('@/hooks/use-user-idle', () => ({ useIdleAwareRefetchInterval: () => false }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.granted.has(permission) }),
}));
vi.mock('@/hooks/queries/use-pipelines-queries', () => ({
  usePipelines: () => ({ data: { data: [] }, isLoading: false }),
  usePipelineStages: () => ({ data: { data: [] } }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ThreadView } from './thread-view';

const ourStep = messageFixture('msg_out', {
  direction: 'out',
  kind: null,
  label: null,
  labelSource: null,
  status: 'sent',
  fromEmail: 'sam@outreach.example',
  toEmail: 'ana@acme.com',
  subject: 'Quick question',
  bodyText: 'Hi Ana, do you have a minute?',
  receivedAt: null,
  sentAt: '2026-10-11T09:00:00Z',
  readAt: null,
});

function mount(threadKey = 'thr_1') {
  return renderWithApp(<ThreadView threadKey={threadKey} onBack={vi.fn()} />);
}

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  for (const fn of Object.values(reach)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.granted = new Set(['reach_inbox:read', 'reach_inbox:update', 'reach_inbox:reply']);
  reach.updateMessage.mockResolvedValue({ data: messageFixture('msg_in') });
  reach.reply.mockResolvedValue({ data: messageFixture('msg_reply', { direction: 'out' }) });
});

describe('ThreadView', () => {
  it('shows the sent step and the reply in order, and marks the reply read once', async () => {
    reach.getThread.mockResolvedValue({ data: threadFixture([messageFixture('msg_in'), ourStep]) });
    mount();

    const articles = await screen.findAllByRole('article');
    expect(articles).toHaveLength(2);
    // Oldest first, whichever side sent it.
    expect(articles[0]).toHaveTextContent('Hi Ana, do you have a minute?');
    expect(articles[1]).toHaveTextContent('Sounds interesting, tell me more.');

    await waitFor(() => expect(reach.updateMessage).toHaveBeenCalledTimes(1));
    expect(reach.updateMessage).toHaveBeenCalledWith('msg_in', { read: true });
  });

  it('does not mark anything read without the update permission', async () => {
    permissions.granted = new Set(['reach_inbox:read']);
    reach.getThread.mockResolvedValue({ data: threadFixture([messageFixture('msg_in'), ourStep]) });
    mount();

    await screen.findAllByRole('article');
    expect(reach.updateMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Mark as handled' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Write your reply…')).not.toBeInTheDocument();
  });

  it('sends the reply with Ctrl+Enter and clears the composer', async () => {
    const user = userEvent.setup();
    reach.getThread.mockResolvedValue({
      data: threadFixture([messageFixture('msg_in', { readAt: '2026-10-12T10:01:00Z' }), ourStep]),
    });
    mount();

    const composer = await screen.findByPlaceholderText('Write your reply…');
    await user.type(composer, 'Happy to talk. Tuesday?');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(reach.reply).toHaveBeenCalledWith('thr_1', 'Happy to talk. Tuesday?'));
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(toast.success).toHaveBeenCalledWith('Reply sent.');
  });

  it('keeps the draft and shows the reason when sending fails', async () => {
    const user = userEvent.setup();
    reach.getThread.mockResolvedValue({
      data: threadFixture([messageFixture('msg_in', { readAt: '2026-10-12T10:01:00Z' })]),
    });
    reach.reply.mockRejectedValue(new Error('Mailbox is paused.'));
    mount();

    const composer = await screen.findByPlaceholderText('Write your reply…');
    await user.type(composer, 'Hello again');
    await user.click(screen.getByRole('button', { name: /Send reply/ }));

    expect(await screen.findByText('Mailbox is paused.')).toBeInTheDocument();
    expect(composer).toHaveValue('Hello again');
  });

  it('offers no composer when the reply was a bounce', async () => {
    reach.getThread.mockResolvedValue({
      data: threadFixture([
        ourStep,
        messageFixture('msg_bounce', { kind: 'bounce', label: null, labelSource: null, readAt: '2026-10-12T10:01:00Z' }),
      ]),
    });
    mount();

    expect(await screen.findByText('This email bounced, so there is nobody to answer.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Write your reply…')).not.toBeInTheDocument();
  });

  it('changes the label of the latest reply', async () => {
    const user = userEvent.setup();
    reach.getThread.mockResolvedValue({
      data: threadFixture([messageFixture('msg_in', { readAt: '2026-10-12T10:01:00Z' })]),
    });
    mount();

    await user.click(await screen.findByRole('button', { name: /Change label/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Not now' }));

    await waitFor(() => expect(reach.updateMessage).toHaveBeenCalledWith('msg_in', { label: 'not_now' }));
  });

  it('marks the conversation handled', async () => {
    const user = userEvent.setup();
    reach.getThread.mockResolvedValue({
      data: threadFixture([messageFixture('msg_in', { readAt: '2026-10-12T10:01:00Z' })]),
    });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Mark as handled' }));
    await waitFor(() => expect(reach.updateMessage).toHaveBeenCalledWith('msg_in', { handled: true }));
  });

  it('links to the CRM person once there is one, and offers to add one before that', async () => {
    reach.getThread.mockResolvedValue({
      data: threadFixture([messageFixture('msg_in', { readAt: '2026-10-12T10:01:00Z' })], {
        prospect: {
          id: 'prs_1',
          email: 'ana@acme.com',
          firstName: 'Ana',
          lastName: 'Jansen',
          companyName: 'Acme',
          personId: 'per_7',
        },
      }),
    });
    mount();

    const link = await screen.findByRole('link', { name: /Open in CRM/ });
    expect(link).toHaveAttribute('href', '/weldcrm/people?stack=person:per_7:panel');
    expect(screen.queryByRole('button', { name: /Add to CRM/ })).not.toBeInTheDocument();
  });

  it('adds the person to the CRM from the dialog', async () => {
    const user = userEvent.setup();
    reach.getThread.mockResolvedValue({
      data: threadFixture([messageFixture('msg_in', { readAt: '2026-10-12T10:01:00Z' })]),
    });
    reach.addToCrm.mockResolvedValue({ data: { personId: 'per_7', opportunityId: null } });
    mount();

    await user.click(await screen.findByRole('button', { name: /Add to CRM/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add to CRM' }));

    await waitFor(() => expect(reach.addToCrm).toHaveBeenCalledWith('thr_1', {}));
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail, SignEventDto, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({
  weldsign: {
    signingLink: vi.fn(),
    remind: vi.fn(),
    resendRecipient: vi.fn(),
    correctRecipient: vi.fn(),
    voidEnvelope: vi.fn(),
    events: vi.fn(),
    download: vi.fn(),
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { weldsignKeys } from '@/hooks/queries/use-weldsign-queries';
import { EnvelopeOverview } from './overview';

const to = en.weldsign.overview;

function recipient(overrides: Partial<SignRecipientDto> = {}): SignRecipientDto {
  return {
    id: 'rcp_ann',
    role: 'signer',
    roleName: null,
    name: 'Ann',
    email: 'ann@example.com',
    personId: null,
    locale: 'en',
    routingOrder: 1,
    authMode: 'link',
    hasAccessCode: false,
    status: 'sent',
    sentAt: '2026-10-24T10:00:00.000Z',
    openedAt: null,
    signedAt: null,
    declinedAt: null,
    declineReason: null,
    lastRemindedAt: null,
    remindersSent: 0,
    ...overrides,
  };
}

const ann = recipient();
const bob = recipient({ id: 'rcp_bob', name: 'Bob', email: 'bob@example.com', routingOrder: 2, status: 'pending', sentAt: null });
const cara = recipient({ id: 'rcp_cara', role: 'cc', name: 'Cara', email: 'cara@example.com', status: 'pending', sentAt: null });
const dan = recipient({ id: 'rcp_dan', name: 'Dan', email: 'dan@example.com', status: 'signed', signedAt: '2026-10-24T11:00:00.000Z' });
const eve = recipient({
  id: 'rcp_eve',
  name: 'Eve',
  email: 'eve@example.com',
  status: 'declined',
  declinedAt: '2026-10-24T12:00:00.000Z',
  declineReason: 'Wrong amount',
});

function envelope(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  const recipientList = overrides.recipientList ?? [ann, bob, cara];
  return {
    id: 'sgn_1',
    kind: 'envelope',
    title: 'Service agreement',
    status: 'sent',
    senderUserId: 'user_1',
    senderName: 'Gert',
    documentCount: 1,
    recipients: { signers: recipientList.filter((r) => r.role === 'signer').length, signed: 0, cc: 1 },
    recipientPreview: [],
    sentAt: '2026-10-24T10:00:00.000Z',
    completedAt: null,
    expiresAt: '2026-11-24T10:00:00.000Z',
    createdAt: '2026-10-24T09:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    message: null,
    signingOrderEnabled: false,
    reminderAfterDays: null,
    reminderEveryDays: null,
    reminderMaxCount: null,
    documents: [],
    recipientList,
    fields: [],
    voidedReason: null,
    voidedAt: null,
    canEdit: false,
    isOwner: false,
    canVoid: false,
    canRemind: false,
    mySignerId: null,
    ...overrides,
  };
}

/** What the sender sees: every lifecycle action. */
const OWNER = { isOwner: true, canVoid: true, canRemind: true } as const;

function event(overrides: Partial<SignEventDto> & Pick<SignEventDto, 'id' | 'type'>): SignEventDto {
  return {
    recipientId: null,
    recipientName: null,
    actorName: null,
    actorEmail: null,
    ip: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    details: null,
    ...overrides,
  };
}

function renderOverview(detail: SignEnvelopeDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <EnvelopeOverview envelope={detail} onViewDocuments={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeAll(() => {
  // Radix menus and dialogs lean on pointer APIs jsdom lacks.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  for (const fn of Object.values(api.weldsign)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.weldsign.events.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
}

describe('EnvelopeOverview without any rights', () => {
  it('shows the request and nothing to act on', () => {
    renderOverview(envelope({ recipientList: [ann, bob, cara, dan, eve] }));

    expect(screen.getByText('Ann')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: to.signNow })).toBeNull();
    expect(screen.queryByRole('button', { name: to.remind })).toBeNull();
    expect(screen.queryByRole('button', { name: to.void.action })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole('region', { name: to.activity.title })).toBeNull();
  });

  it('does not even ask for the activity', () => {
    renderOverview(envelope());
    expect(api.weldsign.events).not.toHaveBeenCalled();
  });
});

describe('Sign now', () => {
  /** The tab `window.open` hands back on the click, before the link is known. */
  function blankTab() {
    return { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
  }

  it('opens a tab on the click and sends it to a fresh link', async () => {
    const tab = blankTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    api.weldsign.signingLink.mockResolvedValue({ data: { url: 'https://sign.example.com/r/abc123' } });
    const user = userEvent.setup();
    renderOverview(envelope({ mySignerId: 'rcp_ann' }));

    await user.click(screen.getByRole('button', { name: to.signNow }));

    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://sign.example.com/r/abc123'));
    expect(tab.opener).toBeNull();
    expect(api.weldsign.signingLink).toHaveBeenCalledWith('sgn_1');
  });

  it('falls back to opening the link when the blank tab was blocked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    api.weldsign.signingLink.mockResolvedValue({ data: { url: 'https://sign.example.com/r/abc123' } });
    const user = userEvent.setup();
    renderOverview(envelope({ mySignerId: 'rcp_ann' }));

    await user.click(screen.getByRole('button', { name: to.signNow }));

    await waitFor(() => expect(open).toHaveBeenCalledWith('https://sign.example.com/r/abc123', '_blank', 'noopener'));
  });

  it('says so and closes the tab when the link could not be made', async () => {
    const tab = blankTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    api.weldsign.signingLink.mockRejectedValue(new ApiError('Not your turn', 400));
    const user = userEvent.setup();
    renderOverview(envelope({ mySignerId: 'rcp_ann' }));

    await user.click(screen.getByRole('button', { name: to.signNow }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${to.signNowFailed}: Not your turn`));
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });
});

describe('Remind', () => {
  it('reminds and tells how many signers were reminded', async () => {
    api.weldsign.remind.mockResolvedValue({ data: { reminded: 2 } });
    const user = userEvent.setup();
    const { invalidate } = renderOverview(envelope({ canRemind: true }));

    await user.click(screen.getByRole('button', { name: to.remind }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reminded 2 signers'));
    expect(api.weldsign.remind).toHaveBeenCalledWith('sgn_1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldsignKeys.envelope('sgn_1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldsignKeys.lists() });
  });

  it('uses the singular for one signer', async () => {
    api.weldsign.remind.mockResolvedValue({ data: { reminded: 1 } });
    const user = userEvent.setup();
    renderOverview(envelope({ canRemind: true }));

    await user.click(screen.getByRole('button', { name: to.remind }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reminded 1 signer'));
  });

  it('shows that everyone was reminded recently on a 409', async () => {
    api.weldsign.remind.mockRejectedValue(new ApiError('Reminded a moment ago', 409));
    const user = userEvent.setup();
    renderOverview(envelope({ canRemind: true }));

    await user.click(screen.getByRole('button', { name: to.remind }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(to.remindedRecently));
  });

  it('passes on the server reason when the mail is refused', async () => {
    api.weldsign.remind.mockRejectedValue(new ApiError('Daily email limit reached', 400));
    const user = userEvent.setup();
    renderOverview(envelope({ canRemind: true }));

    await user.click(screen.getByRole('button', { name: to.remind }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${to.remindFailed}: Daily email limit reached`));
  });
});

describe('recipient menu', () => {
  const everyone = [ann, bob, cara, dan, eve];

  it('offers each recipient only what fits their state', async () => {
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER, recipientList: everyone }));

    // Someone who has signed or declined can no longer be changed.
    expect(screen.queryByRole('button', { name: 'Actions for Dan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Eve' })).toBeNull();

    // A signer whose turn it is: a new link, or a corrected email.
    await openMenu(user, 'Ann');
    expect(screen.getByRole('menuitem', { name: to.resendLink })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: to.correctEmail })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // A signer who waits for their turn: nothing to resend yet.
    await openMenu(user, 'Bob');
    expect(screen.queryByRole('menuitem', { name: to.resendLink })).toBeNull();
    expect(screen.getByRole('menuitem', { name: to.correctEmail })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // A copy recipient can have their email corrected too.
    await openMenu(user, 'Cara');
    expect(screen.queryByRole('menuitem', { name: to.resendLink })).toBeNull();
    expect(screen.getByRole('menuitem', { name: to.correctEmail })).toBeInTheDocument();
  });

  it('has no menu without canRemind', () => {
    renderOverview(envelope({ isOwner: true, canVoid: true, canRemind: false, recipientList: everyone }));
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('resends the link of the signer whose turn it is', async () => {
    api.weldsign.resendRecipient.mockResolvedValue({ data: ann });
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));

    await openMenu(user, 'Ann');
    await user.click(screen.getByRole('menuitem', { name: to.resendLink }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('A new link was sent to ann@example.com'));
    expect(api.weldsign.resendRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann');
  });

  it('says the request is closed when a resend hits a 409', async () => {
    api.weldsign.resendRecipient.mockRejectedValue(new ApiError('Request is completed', 409));
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));

    await openMenu(user, 'Ann');
    await user.click(screen.getByRole('menuitem', { name: to.resendLink }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(to.notOpen));
  });
});

describe('correct email dialog', () => {
  async function openCorrect(user: ReturnType<typeof userEvent.setup>, name = 'Ann') {
    await openMenu(user, name);
    await user.click(screen.getByRole('menuitem', { name: to.correctEmail }));
    return screen.findByRole('dialog');
  }

  it('starts from the recipient and explains that the old link stops working', async () => {
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));

    const dialog = await openCorrect(user);

    expect(within(dialog).getByLabelText(to.correct.name)).toHaveValue('Ann');
    expect(within(dialog).getByLabelText(to.correct.email)).toHaveValue('ann@example.com');
    expect(within(dialog).getByText(/old link stops working/)).toBeInTheDocument();
    // The server refuses a correction that changes nothing.
    expect(within(dialog).getByRole('button', { name: to.correct.save })).toBeDisabled();
  });

  it('does not promise a new link to someone who has not had one yet', async () => {
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));

    const dialog = await openCorrect(user, 'Bob');

    expect(within(dialog).queryByText(/old link stops working/)).toBeNull();
    expect(within(dialog).getByText(/emailed at the new address/)).toBeInTheDocument();
  });

  it('sends the corrected email, lower-cased, and closes', async () => {
    api.weldsign.correctRecipient.mockResolvedValue({ data: ann });
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));
    const dialog = await openCorrect(user);

    const email = within(dialog).getByLabelText(to.correct.email);
    await user.clear(email);
    await user.type(email, 'Ann.New@Example.com');
    await user.click(within(dialog).getByRole('button', { name: to.correct.save }));

    await waitFor(() => expect(api.weldsign.correctRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { email: 'ann.new@example.com' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(to.correct.done));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends the name too when it changed', async () => {
    api.weldsign.correctRecipient.mockResolvedValue({ data: ann });
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));
    const dialog = await openCorrect(user);

    const name = within(dialog).getByLabelText(to.correct.name);
    await user.clear(name);
    await user.type(name, 'Anna');
    await user.click(within(dialog).getByRole('button', { name: to.correct.save }));

    await waitFor(() =>
      expect(api.weldsign.correctRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { email: 'ann@example.com', name: 'Anna' }),
    );
  });

  it('refuses an invalid email without calling the server', async () => {
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));
    const dialog = await openCorrect(user);

    const email = within(dialog).getByLabelText(to.correct.email);
    await user.clear(email);
    await user.type(email, 'not-an-email');
    await user.click(within(dialog).getByRole('button', { name: to.correct.save }));

    expect(await within(dialog).findByText(en.weldsign.editor.recipients.invalidEmail)).toBeInTheDocument();
    expect(api.weldsign.correctRecipient).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the reason when the server refuses', async () => {
    api.weldsign.correctRecipient.mockRejectedValue(new ApiError('Daily email limit reached', 400));
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));
    const dialog = await openCorrect(user);

    const email = within(dialog).getByLabelText(to.correct.email);
    await user.clear(email);
    await user.type(email, 'ann@other.test');
    await user.click(within(dialog).getByRole('button', { name: to.correct.save }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${to.correct.failed}: Daily email limit reached`));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('void dialog', () => {
  it('is only offered to someone who may void', () => {
    renderOverview(envelope({ isOwner: true, canVoid: false, canRemind: true }));
    expect(screen.queryByRole('button', { name: to.void.action })).toBeNull();
  });

  it('warns that signers are told and their links stop working', async () => {
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));

    await user.click(screen.getByRole('button', { name: to.void.action }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/are told that it was cancelled, and their links stop working/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Service agreement/)).toBeInTheDocument();
  });

  it('requires a reason', async () => {
    api.weldsign.voidEnvelope.mockResolvedValue({ data: envelope({ status: 'voided' }) });
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));
    await user.click(screen.getByRole('button', { name: to.void.action }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: to.void.confirm });

    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(to.void.reason), '   ');
    expect(confirm).toBeDisabled();
    expect(api.weldsign.voidEnvelope).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(to.void.reason), 'Signed on paper instead');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(api.weldsign.voidEnvelope).toHaveBeenCalledWith('sgn_1', { reason: 'Signed on paper instead' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(to.void.done));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refreshes the request so its buttons go away', async () => {
    api.weldsign.voidEnvelope.mockResolvedValue({ data: envelope({ status: 'voided' }) });
    const user = userEvent.setup();
    const { invalidate } = renderOverview(envelope({ ...OWNER }));
    await user.click(screen.getByRole('button', { name: to.void.action }));
    await user.type(await screen.findByLabelText(to.void.reason), 'Duplicate');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: to.void.confirm }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: weldsignKeys.envelope('sgn_1') }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldsignKeys.lists() });
  });

  it('keeps the dialog open and shows the reason when voiding fails', async () => {
    api.weldsign.voidEnvelope.mockRejectedValue(new ApiError('Mail provider is down', 500));
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));
    await user.click(screen.getByRole('button', { name: to.void.action }));
    await user.type(await screen.findByLabelText(to.void.reason), 'Duplicate');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: to.void.confirm }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${to.void.failed}: Mail provider is down`));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('what the request shows', () => {
  it('shows who voided it, when and why', () => {
    renderOverview(
      envelope({ status: 'voided', voidedReason: 'Wrong contract attached', voidedAt: '2026-10-25T08:00:00.000Z', recipientList: [ann] }),
    );
    expect(screen.getByText(to.voidedNote)).toBeInTheDocument();
    expect(screen.getByText('Reason: Wrong contract attached')).toBeInTheDocument();
    expect(screen.getByText(/^Voided /)).toBeInTheDocument();
  });

  it('shows why a recipient declined', () => {
    renderOverview(envelope({ status: 'declined', recipientList: [ann, eve] }));
    expect(screen.getByText('Reason: Wrong amount')).toBeInTheDocument();
  });

  it('shows when a signer who has not acted was last reminded, with the automatic count', () => {
    renderOverview(
      envelope({
        recipientList: [recipient({ lastRemindedAt: '2026-10-26T09:30:00.000Z', remindersSent: 2 }), bob],
      }),
    );
    expect(screen.getByText(/^Reminded .* · 2 automatic reminders$/)).toBeInTheDocument();
  });

  it('shows a reminder without a count when none was automatic', () => {
    renderOverview(envelope({ recipientList: [recipient({ lastRemindedAt: '2026-10-26T09:30:00.000Z', remindersSent: 0 })] }));
    expect(screen.getByText(/^Reminded [^·]*$/)).toBeInTheDocument();
  });

  it('does not show a reminder for someone who already signed', () => {
    renderOverview(envelope({ recipientList: [recipient({ ...dan, lastRemindedAt: '2026-10-26T09:30:00.000Z', remindersSent: 1 })] }));
    expect(screen.queryByText(/^Reminded /)).toBeNull();
  });
});

describe('activity', () => {
  const events: SignEventDto[] = [
    event({ id: 'e1', type: 'created', actorName: 'Gert' }),
    event({ id: 'e2', type: 'sent', recipientName: 'Ann', actorName: 'Gert', ip: '203.0.113.7' }),
    event({ id: 'e3', type: 'opened', recipientName: 'Ann', ip: '198.51.100.20' }),
    event({ id: 'e4', type: 'declined', recipientName: 'Eve', details: { reason: 'Wrong amount' } }),
    event({ id: 'e5', type: 'recipient_corrected', recipientName: 'Ann', details: { from: 'ann@old.test', to: 'ann@example.com' } }),
    event({ id: 'e6', type: 'reminded', recipientName: 'Ann' }),
    event({ id: 'e7', type: 'teleported' as SignEventDto['type'], recipientName: 'Ann' }),
    event({ id: 'e8', type: 'voided', actorName: 'Gert', details: { reason: 'Duplicate' } }),
  ];

  it('lists the events oldest first, in plain sentences, and skips a type it does not know', async () => {
    api.weldsign.events.mockResolvedValue({ data: events });
    renderOverview(envelope({ ...OWNER }));

    const section = await screen.findByRole('region', { name: to.activity.title });
    await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(7));

    const lines = within(section)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('p')?.textContent);
    expect(lines).toEqual([
      'Request created',
      'Sent to Ann',
      'Opened by Ann',
      'Declined by Eve',
      'Email of Ann changed from ann@old.test to ann@example.com',
      'Automatic reminder sent to Ann',
      'Request voided',
    ]);
    expect(api.weldsign.events).toHaveBeenCalledWith('sgn_1');
  });

  it('shows the reason, who acted and the IP in muted text', async () => {
    api.weldsign.events.mockResolvedValue({ data: events });
    renderOverview(envelope({ ...OWNER }));

    const section = await screen.findByRole('region', { name: to.activity.title });
    expect(await within(section).findByText('Reason: Wrong amount')).toBeInTheDocument();
    expect(within(section).getByText('Reason: Duplicate')).toBeInTheDocument();
    expect(within(section).getByText('203.0.113.7', { exact: false })).toBeInTheDocument();
    expect(within(section).getByText('198.51.100.20', { exact: false })).toBeInTheDocument();
    expect(within(section).getAllByText(/by Gert/).length).toBeGreaterThan(0);
  });

  it('says so when there is nothing yet', async () => {
    renderOverview(envelope({ ...OWNER }));
    expect(await screen.findByText(to.activity.empty)).toBeInTheDocument();
  });

  it('offers a retry when the activity cannot be loaded', async () => {
    api.weldsign.events.mockRejectedValueOnce(new ApiError('Boom', 500)).mockResolvedValue({ data: [event({ id: 'e1', type: 'created' })] });
    const user = userEvent.setup();
    renderOverview(envelope({ ...OWNER }));

    await user.click(await screen.findByRole('button', { name: to.activity.retry }));

    expect(await screen.findByText('Request created')).toBeInTheDocument();
  });
});

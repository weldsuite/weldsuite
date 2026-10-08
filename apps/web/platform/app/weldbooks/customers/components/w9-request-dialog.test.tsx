import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (v: string) => `date:${v}`, formatDateTime: (v: string) => `datetime:${v}` }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { W9RequestDialog } from './w9-request-dialog';

const LINK = 'https://app.weldsuite.org/w9/Zm9vYmFyYmF6cXV4';

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w9r_1',
    entityId: 'e1',
    partyId: 'c1',
    email: 'billing@acme.test',
    status: 'pending',
    expiresAt: '2026-11-01T00:00:00.000Z',
    completedAt: null,
    requestedBy: 'user_1',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function Harness({ open }: Readonly<{ open: boolean }>) {
  return <W9RequestDialog open={open} onOpenChange={vi.fn()} partyId="c1" defaultEmail="billing@acme.test" />;
}

function wrap(open: boolean, client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  const ui = (isOpen: boolean) => (
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <Harness open={isOpen} />
      </I18nProvider>
    </QueryClientProvider>
  );
  const view = render(ui(open));
  return { ...view, setOpen: (isOpen: boolean) => view.rerender(ui(isOpen)), client };
}

const writeText = vi.fn();

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

/** user-event installs its own clipboard when it is set up, so ours goes in after. */
function setupUser() {
  const user = userEvent.setup();
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
  return user;
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockResolvedValue({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe('W9RequestDialog', () => {
  it('creates a request for the vendor, with its email and the default expiry, and shows the link once', async () => {
    api.post.mockResolvedValue({ data: { request: request(), url: LINK, emailSent: false } });
    const user = userEvent.setup();
    wrap(true);
    expect((screen.getByLabelText(/Vendor email/) as HTMLInputElement).value).toBe('billing@acme.test');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    const panel = await screen.findByTestId('w9-link-panel');
    expect(api.post).toHaveBeenCalledWith('/w9-requests', { partyId: 'c1', email: 'billing@acme.test', expiresInDays: 30 });
    expect((within(panel).getByLabelText('Link for the vendor') as HTMLInputElement).value).toBe(LINK);
    expect(within(panel).getByText('Copy this link and send it to the vendor. Nothing is emailed from here.')).toBeTruthy();
    expect(within(panel).getByText('The link is shown only now. If you lose it, create a new one.')).toBeTruthy();
  });

  it('copies the link', async () => {
    api.post.mockResolvedValue({ data: { request: request(), url: LINK, emailSent: false } });
    const user = setupUser();
    wrap(true);
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(toast.success).toHaveBeenCalledWith('Link copied');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says so when the clipboard is not available, leaving the link to select by hand', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    api.post.mockResolvedValue({ data: { request: request(), url: LINK, emailSent: false } });
    const user = setupUser();
    wrap(true);
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The link could not be copied. Select it and copy it by hand.'));
  });

  it('drops the link when the dialog closes: the server keeps only its hash, so it cannot be shown again', async () => {
    api.post.mockResolvedValue({ data: { request: request(), url: LINK, emailSent: false } });
    const user = userEvent.setup();
    const { setOpen } = wrap(true);
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByTestId('w9-link-panel');

    setOpen(false);
    setOpen(true);
    expect(screen.queryByTestId('w9-link-panel')).toBeNull();
    expect(screen.queryByDisplayValue(LINK)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeTruthy();
  });

  it('sends the chosen expiry and no email when it is cleared', async () => {
    api.post.mockResolvedValue({ data: { request: request(), url: LINK, emailSent: false } });
    const user = userEvent.setup();
    wrap(true);
    await user.clear(screen.getByLabelText(/Vendor email/));
    await user.click(screen.getByRole('combobox', { name: 'Link expires after' }));
    await user.click(await screen.findByRole('option', { name: '7 days' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/w9-requests', { partyId: 'c1', email: undefined, expiresInDays: 7 }));
  });

  it('shows the earlier requests with their status, and cancels a waiting one', async () => {
    api.get.mockResolvedValue({
      data: [request(), request({ id: 'w9r_0', status: 'completed', completedAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-18T00:00:00.000Z' })],
      pagination: { totalCount: 2, hasMore: false, cursor: null },
    });
    api.post.mockResolvedValue({ data: request({ status: 'cancelled' }) });
    const user = userEvent.setup();
    wrap(true);
    expect(await screen.findByText('Waiting')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/w9-requests?partyId=c1');
    // Only the waiting one can be cancelled.
    expect(screen.getAllByRole('button', { name: 'Cancel request' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/w9-requests/w9r_1/cancel'));
  });

  it('says so when the request could not be created', async () => {
    api.post.mockRejectedValue(new Error('Contact with ID c1 not found'));
    const user = userEvent.setup();
    wrap(true);
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The request could not be created', { description: 'Contact with ID c1 not found' }),
    );
    expect(screen.queryByTestId('w9-link-panel')).toBeNull();
  });
});

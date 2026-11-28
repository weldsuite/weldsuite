import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast: env.toast }));

import { SendEmailDialog, type SendEmailDialogProps } from './send-email-dialog';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import type { EmailDelivery, SendEmailInput } from '@/lib/api/domains/weldbooks-sales';

const delivery = (overrides: Partial<EmailDelivery> = {}): EmailDelivery => ({
  messageId: 'm1',
  to: ['klant@example.test'],
  subject: 'Factuur F-1',
  link: 'https://pay.example.test/d/abc',
  ...overrides,
});

function renderDialog(props: Partial<SendEmailDialogProps> = {}) {
  const send = vi.fn<(input: SendEmailInput) => Promise<EmailDelivery>>(async () => delivery());
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <SendEmailDialog
      kind="invoice"
      open
      onOpenChange={onOpenChange}
      defaultTo="klant@example.test"
      entityName="Acme B.V."
      documentNumber="F-1"
      send={send}
      {...props}
    />,
  );
  return { send, onOpenChange, ...utils };
}

describe('SendEmailDialog', () => {
  beforeEach(() => {
    env.toast.success.mockReset();
    env.toast.error.mockReset();
  });

  it('says in plain words that it goes out in the entity’s name and replies to its address', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Send invoice' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'WeldSuite sends this e-mail in the name of Acme B.V.. If your customer replies, the answer goes to the e-mail address of Acme B.V..',
      ),
    ).toBeInTheDocument();
  });

  it('names the document kind in the title', () => {
    renderDialog({ kind: 'quote' });
    expect(screen.getByRole('heading', { name: 'Send quote' })).toBeInTheDocument();
  });

  it('prefills To from the contact and leaves subject and text to the entity template', async () => {
    const user = userEvent.setup();
    const { send } = renderDialog();
    expect(screen.getByLabelText('To')).toHaveValue('klant@example.test');
    // The template applies on the server: no subject or message field until the owner asks to write their own.
    expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
    expect(screen.getByText(/come from your e-mail text in Settings/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({ to: ['klant@example.test'], attachPdf: true, includeLink: true });
  });

  it('sends Cc, its own subject and text, and the switches as set', async () => {
    const user = userEvent.setup();
    const { send } = renderDialog();
    await user.type(screen.getByLabelText('Cc'), 'boekhouder@example.test');
    await user.click(screen.getByRole('button', { name: 'Write your own text' }));
    await user.type(screen.getByLabelText('Subject'), 'Je factuur');
    await user.type(screen.getByLabelText('Message'), 'Hallo!');
    await user.click(screen.getByRole('switch', { name: 'Attach the PDF' }));
    await user.click(screen.getByRole('switch', { name: 'Include the online link' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      to: ['klant@example.test'],
      cc: ['boekhouder@example.test'],
      subject: 'Je factuur',
      body: 'Hallo!',
      attachPdf: false,
      includeLink: false,
    });
  });

  it('does not send without an address, says why, and puts the focus in To', async () => {
    const user = userEvent.setup();
    const { send } = renderDialog({ defaultTo: '' });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Enter at least one e-mail address.')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('To')).toHaveFocus();
  });

  it('refuses an address that is not one, naming it', async () => {
    const user = userEvent.setup();
    const { send } = renderDialog({ defaultTo: 'klant@example.test, nope' });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('"nope" is not a valid e-mail address.')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('shows to whom it went and the link, which can be copied', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderDialog({ send: vi.fn(async () => delivery({ cc: ['boekhouder@example.test'] })) });
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/F-1 was sent to klant@example.test\. A copy went to boekhouder@example.test\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Online link')).toHaveValue('https://pay.example.test/d/abc');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('https://pay.example.test/d/abc');
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  });

  it('says so when the e-mail went without a link', async () => {
    const user = userEvent.setup();
    renderDialog({ send: vi.fn(async () => delivery({ link: null })) });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This e-mail went out without the online link.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
  });

  it('explains a server without mail in plain words', async () => {
    const user = userEvent.setup();
    const unavailable = Object.assign(new Error('Service unavailable'), { status: 503 });
    renderDialog({ send: vi.fn(async () => Promise.reject(unavailable)) });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(env.toast.error).toHaveBeenCalledWith('The e-mail could not be sent', {
        description: 'Sending e-mail or the online page is not set up on this server yet. Ask your administrator.',
      }),
    );
  });

  it('lets the caller show a refusal itself (a sales tax notice) and closes', async () => {
    const user = userEvent.setup();
    const refusal = new Error('tax');
    const onFailure = vi.fn(() => true);
    const { onOpenChange } = renderDialog({ send: vi.fn(async () => Promise.reject(refusal)), onFailure });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(refusal));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(env.toast.error).not.toHaveBeenCalled();
  });

  it('holds Send back while the company details are missing', () => {
    renderDialog({ sendDisabled: true });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

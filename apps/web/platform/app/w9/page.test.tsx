import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ token: 'tok_abc123' }) }));

import PublicW9Page from './page';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const calls: FetchCall[] = [];
const respond = vi.hoisted(() => ({ handler: null as null | ((call: { url: string; method: string; body: unknown }) => { status: number; body: unknown }) }));

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const out = respond.handler!({ url, method: init?.method ?? 'GET', body });
      return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
    }),
  );
}

const request = { data: { payer: { name: 'Acme Corp' }, vendor: { displayName: 'Jane Plumbing' }, expiresAt: '2026-11-07T00:00:00.000Z' } };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <PublicW9Page />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  calls.length = 0;
  respond.handler = ({ method }) => (method === 'GET' ? { status: 200, body: request } : { status: 200, body: { data: { completed: true } } });
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Name \(as shown/), 'Jane Q. Public');
  await user.click(screen.getByRole('radio', { name: /Individual or sole proprietor/ }));
  await user.type(screen.getByLabelText(/^Street address/), '1 Main St');
  await user.type(screen.getByLabelText(/^City/), 'Austin');
  await user.click(screen.getByRole('combobox', { name: /^State/ }));
  await user.click(await screen.findByRole('option', { name: /TX · Texas/ }));
  await user.type(screen.getByLabelText(/^ZIP code/), '78701');
  await user.click(screen.getByRole('radio', { name: /^SSN/ }));
  await user.type(screen.getByLabelText(/^Number \*/), '123456789');
  await user.type(screen.getByLabelText(/^Signature/), 'Jane Q. Public');
  await user.click(screen.getByRole('checkbox', { name: /I certify, under penalties of perjury/ }));
}

describe('public W-9 page', () => {
  it('loads the request without sending credentials, and says who asked', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Form W-9' })).toBeTruthy();
    expect(screen.getByText(/Acme Corp asked for this form/)).toBeTruthy();
    expect(screen.getByText(/Requested for Jane Plumbing/)).toBeTruthy();
    const [call] = calls;
    expect(call!.url).toMatch(/\/public\/w9\/tok_abc123$/);
    expect(call!.init?.credentials).toBe('omit');
    expect(JSON.stringify(call!.init?.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('says the link is not available for an unknown, expired or used link: the same answer for all', async () => {
    respond.handler = () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    renderPage();
    expect(await screen.findByTestId('w9-not-available')).toBeTruthy();
    expect(screen.getByText('This link is not available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign and submit' })).toBeNull();
  });

  it('offers a retry when the form could not be loaded for another reason', async () => {
    respond.handler = () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } });
    renderPage();
    expect(await screen.findByText('The form could not be loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows every required field as an error and sends nothing when submitted empty', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Sign and submit' }));
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Choose your tax classification.')).toBeTruthy();
    expect(screen.getByText('Choose a state.')).toBeTruthy();
    expect(screen.getByText('Choose the type of number.')).toBeTruthy();
    expect(screen.getByText('You must certify the form to submit it.')).toBeTruthy();
    expect(calls.filter((c) => c.init?.method === 'POST')).toEqual([]);
  });

  it('checks the number against its type: EIN and SSN formats', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    await user.click(screen.getByRole('radio', { name: /^EIN/ }));
    await user.type(screen.getByLabelText(/^Number \*/), '07-1234567');
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));
    expect(await screen.findByText(/not an EIN prefix the IRS issues/)).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: /^SSN/ }));
    await user.clear(screen.getByLabelText(/^Number \*/));
    await user.type(screen.getByLabelText(/^Number \*/), '12345');
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));
    expect(await screen.findByText(/Enter nine digits/)).toBeTruthy();
  });

  it('asks how an LLC is taxed, and will not submit without it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    expect(screen.queryByLabelText(/How is the LLC taxed/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Limited liability company/ }));
    expect(screen.getByLabelText(/How is the LLC taxed/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));
    expect(await screen.findByText('Choose how the LLC is taxed.')).toBeTruthy();
  });

  it('hides what is typed in the number field until the eye is pressed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    const input = screen.getByLabelText(/^Number \*/) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    await user.click(screen.getByRole('button', { name: 'Show the number' }));
    expect(input.type).toBe('text');
  });

  it('cannot be submitted by someone who is under backup withholding', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    await user.click(screen.getByRole('checkbox', { name: /currently subject to backup withholding/ }));
    expect(screen.getByText('This form cannot be submitted online')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sign and submit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits the form as the endpoint takes it, then says thank you', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));

    expect(await screen.findByTestId('w9-done')).toBeTruthy();
    expect(screen.getByText(/Your W-9 was sent to Acme Corp/)).toBeTruthy();

    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toMatch(/\/public\/w9\/tok_abc123$/);
    expect(post.init?.credentials).toBe('omit');
    expect(JSON.parse(post.init?.body as string)).toEqual({
      legalName: 'Jane Q. Public',
      federalTaxClassification: 'individual',
      address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
      tinType: 'ssn',
      tin: '123-45-6789',
      signedName: 'Jane Q. Public',
      certify: true,
    });
    // Nothing of what was typed stays on the thank-you page.
    expect(document.body.textContent).not.toMatch(/123-45-6789/);
  });

  it('shows the server\'s field errors on the fields they belong to', async () => {
    respond.handler = ({ method }) =>
      method === 'GET'
        ? { status: 200, body: request }
        : { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Check the form', details: { fieldErrors: { 'address.postalCode': ['Not a ZIP code'] } } } } };
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));
    expect(await screen.findByText('Not a ZIP code')).toBeTruthy();
    expect(screen.getByTestId('w9-form-error').textContent).toMatch(/Check the fields marked in red/);
    expect(screen.queryByTestId('w9-done')).toBeNull();
  });

  it('turns into the not-available page when the link stops working while the form is open', async () => {
    respond.handler = ({ method }) => (method === 'GET' ? { status: 200, body: request } : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));
    await waitFor(() => expect(screen.getByTestId('w9-not-available')).toBeTruthy());
  });

  it('asks to try again when the server fails, keeping what was typed', async () => {
    respond.handler = ({ method }) => (method === 'GET' ? { status: 200, body: request } : { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'x' } } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Form W-9' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));
    expect(await screen.findByText(/could not be saved right now/)).toBeTruthy();
    expect((screen.getByLabelText(/^Name \(as shown/) as HTMLInputElement).value).toBe('Jane Q. Public');
  });
});

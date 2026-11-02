import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { ApiError } from '@weldsuite/api-client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';

const api = vi.hoisted(() => ({ weldsign: { create: vi.fn(), addDocumentFromDrive: vi.fn() } }));
const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  installed: new Set<string>(),
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('@/hooks/use-is-app-installed', () => ({ useIsAppInstalled: (code: string) => state.installed.has(code) }));
vi.mock('@/lib/router', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast }));

import type { SignStartSource } from '../lib/source';
import { SendFileForSignatureItem, SendForSignatureItem } from './send-for-signature-item';
import { useStartSignRequest } from './use-start-sign-request';

const ts = en.weldsign.start;

const pdf = { id: 'fil_1', name: 'Service agreement.pdf', mimeType: 'application/pdf', fileType: 'pdf', source: 'drive' };

function wrapper(language: 'en' | 'nl' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Providers({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage={language}>{children}</I18nProvider>
      </QueryClientProvider>
    );
  }
  return Providers;
}

/** An open menu with the item in it, as in a Drive or CRM menu. */
function renderMenu(item: ReactNode, language: 'en' | 'nl' = 'en') {
  const Wrapper = wrapper(language);
  return render(
    <Wrapper>
      <DropdownMenu open>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>{item}</DropdownMenuContent>
      </DropdownMenu>
    </Wrapper>,
  );
}

const menuItem = (name: string = ts.action) => screen.queryByRole('menuitem', { name });

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  state.permissions = new Set(['sign_envelopes:create']);
  state.installed = new Set(['weldsign']);
  for (const fn of Object.values(api.weldsign)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  router.push.mockReset();
  toast.loading.mockReturnValue('toast_1');
  api.weldsign.create.mockResolvedValue({ data: { id: 'sgn_new' } });
  api.weldsign.addDocumentFromDrive.mockResolvedValue({ data: { id: 'sgd_1' } });
});

afterEach(() => cleanup());

describe('Send for signature on a WeldDrive file', () => {
  it('makes a draft from the PDF, copies it in and opens it', async () => {
    const user = userEvent.setup();
    renderMenu(<SendFileForSignatureItem file={pdf} />);

    await user.click(menuItem()!);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/weldsign/sgn_new'));
    // The title is the file name without .pdf, and the draft remembers the file it came from.
    expect(api.weldsign.create).toHaveBeenCalledWith({ title: 'Service agreement', source: { entityType: 'file', entityId: 'fil_1' } });
    expect(api.weldsign.addDocumentFromDrive).toHaveBeenCalledWith('sgn_new', { fileId: 'fil_1' });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows that it is working, and stops showing it', async () => {
    const user = userEvent.setup();
    renderMenu(<SendFileForSignatureItem file={pdf} />);

    await user.click(menuItem()!);

    await waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith('toast_1'));
    expect(toast.loading).toHaveBeenCalledWith('Preparing "Service agreement.pdf" for signature…');
  });

  it('still opens the draft, and says why when the PDF is refused', async () => {
    api.weldsign.addDocumentFromDrive.mockRejectedValue(new ApiError('This PDF is password protected', 400));
    const user = userEvent.setup();
    renderMenu(<SendFileForSignatureItem file={pdf} />);

    await user.click(menuItem()!);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/weldsign/sgn_new'));
    expect(toast.error).toHaveBeenCalledWith('The request was created, but "Service agreement.pdf" could not be added: This PDF is password protected');
    expect(toast.dismiss).toHaveBeenCalledWith('toast_1');
  });

  it('stays where it is and says why when the draft can not be made', async () => {
    api.weldsign.create.mockRejectedValue(new ApiError('File not found', 404));
    const user = userEvent.setup();
    renderMenu(<SendFileForSignatureItem file={pdf} />);

    await user.click(menuItem()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${ts.failed}: File not found`));
    expect(router.push).not.toHaveBeenCalled();
    expect(api.weldsign.addDocumentFromDrive).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith('toast_1');
  });

  it('is in the menu where WeldSign is installed and the member may create requests', () => {
    renderMenu(<SendFileForSignatureItem file={pdf} />);
    expect(menuItem()).toBeInTheDocument();
  });

  it('is left out where WeldSign is not installed', () => {
    state.installed = new Set(['welddrive']);
    renderMenu(<SendFileForSignatureItem file={pdf} />);
    expect(menuItem()).toBeNull();
  });

  it('is left out without sign_envelopes:create', () => {
    state.permissions = new Set(['sign_envelopes:read', 'sign_envelopes:send']);
    renderMenu(<SendFileForSignatureItem file={pdf} />);
    expect(menuItem()).toBeNull();
  });

  it('is left out for a file that is not a PDF of the WeldDrive store', () => {
    renderMenu(
      <>
        <SendFileForSignatureItem file={{ ...pdf, name: 'Budget.xlsx', mimeType: 'application/vnd.ms-excel', fileType: 'spreadsheet' }} />
        <SendFileForSignatureItem file={{ ...pdf, source: 'mail' }} />
      </>,
    );
    expect(menuItem()).toBeNull();
  });

  it('speaks Dutch', async () => {
    renderMenu(<SendFileForSignatureItem file={pdf} />, 'nl');
    expect(await screen.findByRole('menuitem', { name: nl.weldsign.start.action })).toBeInTheDocument();
  });
});

describe('Send for signature on a CRM record', () => {
  const records: { source: SignStartSource; title: string }[] = [
    { source: { entityType: 'company', id: 'cus_1', name: 'Acme BV' }, title: 'Document for Acme BV' },
    { source: { entityType: 'person', id: 'per_1', name: 'Ann Lee' }, title: 'Document for Ann Lee' },
    { source: { entityType: 'opportunity', id: 'opp_1', name: 'Website rebuild' }, title: 'Document for Website rebuild' },
  ];

  it.each(records)('makes a draft for the $source.entityType and opens it', async ({ source, title }) => {
    const user = userEvent.setup();
    renderMenu(<SendForSignatureItem source={source} />);

    await user.click(menuItem()!);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/weldsign/sgn_new'));
    expect(api.weldsign.create).toHaveBeenCalledWith({ title, source: { entityType: source.entityType, entityId: source.id } });
    // There is no file to copy in, and nothing to wait for on screen.
    expect(api.weldsign.addDocumentFromDrive).not.toHaveBeenCalled();
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it('writes the title in Dutch for a Dutch member', async () => {
    const user = userEvent.setup();
    renderMenu(<SendForSignatureItem source={records[0]!.source} />, 'nl');

    await user.click(menuItem(nl.weldsign.start.action)!);

    await waitFor(() => expect(api.weldsign.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Document voor Acme BV' })));
  });

  it('is left out where WeldSign is not installed, and without sign_envelopes:create', () => {
    state.installed = new Set();
    const first = renderMenu(<SendForSignatureItem source={records[0]!.source} />);
    expect(menuItem()).toBeNull();
    first.unmount();

    state.installed = new Set(['weldsign']);
    state.permissions = new Set();
    renderMenu(<SendForSignatureItem source={records[0]!.source} />);
    expect(menuItem()).toBeNull();
  });

  it('titles a record without a name with the untitled label, and keeps a long name within what the API takes', async () => {
    const { result } = renderHook(() => useStartSignRequest(), { wrapper: wrapper() });

    await act(() => result.current.start({ entityType: 'company', id: 'cus_1', name: '   ' }));
    expect(api.weldsign.create).toHaveBeenLastCalledWith(expect.objectContaining({ title: en.weldsign.home.untitled }));

    await act(() => result.current.start({ entityType: 'company', id: 'cus_1', name: 'x'.repeat(400) }));
    const { title } = api.weldsign.create.mock.calls.at(-1)![0] as { title: string };
    expect(title).toHaveLength(255);
    expect(title.startsWith('Document for xxx')).toBe(true);
  });
});

describe('useStartSignRequest', () => {
  it('is available only with WeldSign installed and sign_envelopes:create', () => {
    const { result, rerender } = renderHook(() => useStartSignRequest(), { wrapper: wrapper() });
    expect(result.current.available).toBe(true);

    state.permissions = new Set();
    rerender();
    expect(result.current.available).toBe(false);

    state.permissions = new Set(['sign_envelopes:create']);
    state.installed = new Set();
    rerender();
    expect(result.current.available).toBe(false);
  });

  it('makes one draft however often it is asked while the first is being made', async () => {
    let finish: (value: unknown) => void = () => undefined;
    api.weldsign.create.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useStartSignRequest(), { wrapper: wrapper() });
    const source: SignStartSource = { entityType: 'company', id: 'cus_1', name: 'Acme BV' };

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.start(source);
      void result.current.start(source);
    });
    await act(async () => {
      finish({ data: { id: 'sgn_new' } });
      await first;
    });

    expect(api.weldsign.create).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledTimes(1);

    // Once it is done, the next one is allowed.
    api.weldsign.create.mockResolvedValue({ data: { id: 'sgn_two' } });
    await act(() => result.current.start(source));
    expect(api.weldsign.create).toHaveBeenCalledTimes(2);
  });
});

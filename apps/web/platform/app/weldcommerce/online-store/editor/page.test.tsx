import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultSiteDocument } from '@weldsuite/storefront-theme/catalog';
import type { OnlineStoreSiteDetail } from '@/hooks/queries/use-online-store-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  site: null as unknown,
  search: new URLSearchParams(),
  replace: vi.fn(),
  saveDraft: vi.fn(),
  updatePage: vi.fn(),
  createLink: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission), isLoading: false }),
}));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: true, isLoading: false }) }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => true }));
vi.mock('@/components/edition-unavailable-page', () => ({ EditionUnavailablePage: () => <p>not on this edition</p> }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ siteId: 'sfs_1' }),
  useSearchParams: () => env.search,
  useRouter: () => ({ replace: env.replace, push: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/settings">{children}</a>,
}));
vi.mock('@/hooks/queries/use-online-store-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/queries/use-online-store-queries')>();
  const empty = { data: { data: [] }, isPending: false, isError: false, refetch: vi.fn() };
  return {
    revisionConflict: actual.revisionConflict,
    validationFields: actual.validationFields,
    useOnlineStoreSite: () => env.site,
    useStorePages: () => empty,
    useStorePage: () => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn() }),
    useStoreMenus: () => empty,
    useSiteVersions: () => empty,
    useCreatePreviewLink: () => ({ mutateAsync: env.createLink }),
    useSaveDraft: () => ({ mutateAsync: env.saveDraft }),
    useUpdateStorePage: () => ({ mutateAsync: env.updatePage }),
    usePublishSite: () => ({ mutateAsync: vi.fn() }),
    useRestoreSiteVersion: () => ({ mutateAsync: vi.fn() }),
    useCopyVersionToDraft: () => ({ mutateAsync: vi.fn() }),
  };
});
vi.mock('@/hooks/queries/use-commerce-queries', () => ({ useCommerceCategories: () => ({ data: { data: [] }, isPending: false }) }));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({ useWeldstashProducts: () => ({ data: { data: [] }, isPending: false }) }));

import OnlineStoreEditorPage from './page';

const detail = (over: Partial<OnlineStoreSiteDetail> = {}): OnlineStoreSiteDetail =>
  ({
    id: 'sfs_1',
    channelId: 'ch_1',
    channelName: 'Webshop',
    mode: 'builder',
    locale: 'en',
    draftRevision: 3,
    previewHost: 'webshop.weldshop.eu',
    draft: defaultSiteDocument(),
    ...over,
  }) as OnlineStoreSiteDetail;

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.allowed = new Set(['websites:read', 'websites:update', 'websites:manage']);
  env.site = { data: { data: detail() }, isPending: false, isError: false, refetch: vi.fn() };
  env.search = new URLSearchParams();
  for (const fn of [env.replace, env.saveDraft, env.updatePage, env.createLink]) fn.mockReset();
  env.createLink.mockResolvedValue({ data: { url: 'https://webshop.weldshop.eu/__preview?token=t', expiresAt: '2099-01-01T00:00:00Z' } });
  env.saveDraft.mockResolvedValue({ data: { draftRevision: 4, draftUpdatedAt: 'now' } });
});

describe('OnlineStoreEditorPage', () => {
  it('lays out the sections, the preview and the settings, and saves an edit on its own', async () => {
    const user = userEvent.setup();
    render(<OnlineStoreEditorPage />);
    expect(screen.getByRole('heading', { name: 'Webshop' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Sections' })).toBeTruthy();
    const frame = (await screen.findByTitle('Preview of the shop')) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://webshop.weldshop.eu/__preview?token=t');
    expect(screen.getByText('Choose a section on the left, or click one in the preview, to change its settings.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Hero' }));
    const settings = screen.getByRole('complementary', { name: 'Settings' });
    expect(within(settings).getByRole('heading', { name: 'Hero' })).toBeTruthy();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    await user.type(within(settings).getByLabelText('Heading'), '!');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    await waitFor(() => expect(env.saveDraft).toHaveBeenCalled(), { timeout: 3000 });
    const [{ document, revision }] = env.saveDraft.mock.calls[0] as [{ document: ReturnType<typeof defaultSiteDocument>; revision: number }];
    expect(revision).toBe(3);
    expect(document.templates.home[0]!.settings.heading).toBe('Welcome to our shop!');
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeTruthy());
    // The preview reloads the draft, addressed to its own origin.
    expect(postMessage).toHaveBeenCalledWith({ source: 'weldsuite-storefront', type: 'refresh' }, 'https://webshop.weldshop.eu');
  });

  it('undoes an edit from the top bar', async () => {
    const user = userEvent.setup();
    render(<OnlineStoreEditorPage />);
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Hide Hero' }));
    expect(screen.getByRole('button', { name: 'Show Hero' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Hide Hero' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveProperty('disabled', false);
  });

  it('edits the template chosen in the URL', () => {
    env.search = new URLSearchParams('template=product');
    render(<OnlineStoreEditorPage />);
    expect(screen.getByRole('region', { name: 'Product page' })).toBeTruthy();
    expect(screen.getByText('Open a product or a category in the preview to see this template.')).toBeTruthy();
  });

  it('is read-only without websites:update, and has no Publish without websites:manage', () => {
    env.allowed = new Set(['websites:read']);
    render(<OnlineStoreEditorPage />);
    expect(screen.getByText('You can look at this store but not change it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('asks for an address before it can show a preview', () => {
    env.site = { data: { data: detail({ previewHost: null }) }, isPending: false, isError: false, refetch: vi.fn() };
    render(<OnlineStoreEditorPage />);
    expect(screen.getByText('The preview opens once the shop has an address.')).toBeTruthy();
    expect(env.createLink).not.toHaveBeenCalled();
  });

  it('has no editor for a store built with your own code', () => {
    env.site = { data: { data: detail({ mode: 'static' }) }, isPending: false, isError: false, refetch: vi.fn() };
    render(<OnlineStoreEditorPage />);
    expect(screen.getByText(/built with your own code, so it has no editor/)).toBeTruthy();
  });

  it('says there is no access without websites:read', () => {
    env.allowed = new Set();
    render(<OnlineStoreEditorPage />);
    expect(screen.getByText('You do not have access to the online store.')).toBeTruthy();
  });
});

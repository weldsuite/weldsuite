import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultSiteDocument } from '@weldsuite/storefront-theme/catalog';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  postForm: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => api }),
}));

import {
  onlineStoreErrorCode,
  onlineStoreKeys,
  revisionConflict,
  useCopyVersionToDraft,
  useCreateOnlineStoreSite,
  useCreatePreviewLink,
  useCreateStorePage,
  useCreateStoreRedirect,
  useCreateStorefrontHost,
  useDeleteDeployment,
  useDeleteOnlineStoreSite,
  useDeleteStoreMenu,
  useDeleteStorePage,
  useDeleteStoreRedirect,
  useDeleteStorefrontHost,
  useMakeStorefrontHostPrimary,
  useOnlineStoreSite,
  useOnlineStoreSites,
  usePromoteDeployment,
  usePublishSite,
  useRefreshStorefrontHost,
  useRestoreSiteVersion,
  useSaveDraft,
  useSaveStoreMenu,
  useSiteVersions,
  useStoreDeployments,
  useStoreMenus,
  useStorePage,
  useStorePages,
  useStoreRedirects,
  useStorefrontHosts,
  useStorefrontHostsConfig,
  useUpdateOnlineStoreSite,
  useUpdateStorePage,
  useUploadDeployment,
  validationFields,
  type OnlineStoreSiteDetail,
} from './use-online-store-queries';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue({ data: [] });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue(undefined);
  api.postForm.mockResolvedValue({ data: {} });
});

function invalidated() {
  const spy = vi.spyOn(client, 'invalidateQueries');
  return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
}

const apiError = (status: number, code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { status, body: { error: { code, message: code, details } } });

describe('reads', () => {
  it('reads every collection from its own path', async () => {
    renderHook(() => useOnlineStoreSites(), { wrapper });
    renderHook(() => useOnlineStoreSite('sfs_1'), { wrapper });
    renderHook(() => useSiteVersions('sfs_1'), { wrapper });
    renderHook(() => useStorePages('sfs_1'), { wrapper });
    renderHook(() => useStorePage('sfs_1', 'pg_1'), { wrapper });
    renderHook(() => useStoreMenus('sfs_1'), { wrapper });
    renderHook(() => useStoreRedirects('sfs_1'), { wrapper });
    renderHook(() => useStoreDeployments('sfs_1'), { wrapper });
    renderHook(() => useStorefrontHostsConfig(), { wrapper });
    renderHook(() => useStorefrontHosts('sfs_1'), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(10));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      [
        '/online-store/sites',
        '/online-store/sites/sfs_1',
        '/online-store/sites/sfs_1/versions',
        '/online-store/sites/sfs_1/pages',
        '/online-store/sites/sfs_1/pages/pg_1',
        '/online-store/sites/sfs_1/menus',
        '/online-store/sites/sfs_1/redirects',
        '/online-store/sites/sfs_1/deployments',
        '/storefront-hosts/config',
        '/storefront-hosts?siteId=sfs_1',
      ].sort(),
    );
  });

  it('does not ask without an id or when disabled', () => {
    renderHook(() => useOnlineStoreSite(''), { wrapper });
    renderHook(() => useStorePages('sfs_1', false), { wrapper });
    renderHook(() => useStorefrontHosts(''), { wrapper });
    renderHook(() => useOnlineStoreSites(false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('sites', () => {
  it('creates, updates and deletes a site, refreshing the sites (and the hosts it took with it)', async () => {
    const keys = invalidated();
    const { result } = renderHook(
      () => ({ create: useCreateOnlineStoreSite(), update: useUpdateOnlineStoreSite(), remove: useDeleteOnlineStoreSite() }),
      { wrapper },
    );
    await act(async () => {
      await result.current.create.mutateAsync({ channelId: 'ch_1', mode: 'builder', locale: 'nl' });
      await result.current.update.mutateAsync({ siteId: 'sfs_1', data: { visibility: 'password', password: 'secret' } });
      await result.current.remove.mutateAsync('sfs_1');
    });
    expect(api.post).toHaveBeenCalledWith('/online-store/sites', { channelId: 'ch_1', mode: 'builder', locale: 'nl' });
    expect(api.patch).toHaveBeenCalledWith('/online-store/sites/sfs_1', { visibility: 'password', password: 'secret' });
    expect(api.delete).toHaveBeenCalledWith('/online-store/sites/sfs_1');
    expect(keys()).toContainEqual(onlineStoreKeys.sites());
    expect(keys()).toContainEqual(onlineStoreKeys.hosts('sfs_1'));
  });
});

describe('draft', () => {
  it('saves the document with the revision it was based on and keeps the cached detail in step without refetching it', async () => {
    const document = { ...defaultSiteDocument(), seo: { title: 'Atelier Noord' } };
    const site = { id: 'sfs_1', draftRevision: 3, hasUnpublishedChanges: false, draft: defaultSiteDocument() } as unknown as OnlineStoreSiteDetail;
    client.setQueryData(onlineStoreKeys.site('sfs_1'), { data: site });
    api.put.mockResolvedValue({ data: { draftRevision: 4, draftUpdatedAt: '2026-11-23T10:00:00Z' } });
    const keys = invalidated();
    const { result } = renderHook(() => useSaveDraft(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ siteId: 'sfs_1', document, revision: 3 });
    });
    expect(api.put).toHaveBeenCalledWith('/online-store/sites/sfs_1/draft', { document, revision: 3 });
    const cached = client.getQueryData<{ data: OnlineStoreSiteDetail }>(onlineStoreKeys.site('sfs_1'));
    expect(cached?.data.draftRevision).toBe(4);
    expect(cached?.data.hasUnpublishedChanges).toBe(true);
    expect(cached?.data.draft).toEqual(document);
    expect(keys()).toContainEqual(onlineStoreKeys.siteList());
    expect(keys()).not.toContainEqual(onlineStoreKeys.site('sfs_1'));
  });

  it('reads the revision of a conflict and the fields of a validation error', () => {
    expect(revisionConflict(apiError(409, 'REVISION_CONFLICT', { currentRevision: 7 }))).toBe(7);
    expect(revisionConflict(apiError(409, 'SITE_EXISTS'))).toBeNull();
    expect(revisionConflict(new Error('offline'))).toBeNull();
    expect(validationFields(apiError(400, 'VALIDATION_ERROR', { fields: { 'templates.home[0].settings.heading': 'Too long', bad: 3 } }))).toEqual({
      'templates.home[0].settings.heading': 'Too long',
    });
    expect(validationFields(apiError(409, 'REVISION_CONFLICT'))).toBeNull();
    expect(onlineStoreErrorCode(apiError(409, 'HOST_TAKEN'))).toBe('HOST_TAKEN');
  });
});

describe('publishing', () => {
  it('publishes with a note, restores a version, copies one to the draft and asks for a preview link', async () => {
    const copied = { data: { id: 'sfs_1', draftRevision: 9, draft: defaultSiteDocument() } };
    api.post.mockImplementation(async (path: string) => (path.endsWith('/copy-to-draft') ? copied : { data: {} }));
    const keys = invalidated();
    const { result } = renderHook(
      () => ({
        publish: usePublishSite(),
        restore: useRestoreSiteVersion(),
        copy: useCopyVersionToDraft(),
        preview: useCreatePreviewLink(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.publish.mutateAsync({ siteId: 'sfs_1', note: 'Spring sale' });
      await result.current.publish.mutateAsync({ siteId: 'sfs_1' });
      await result.current.restore.mutateAsync({ siteId: 'sfs_1', versionId: 'sfv_2' });
      await result.current.copy.mutateAsync({ siteId: 'sfs_1', versionId: 'sfv_2' });
      await result.current.preview.mutateAsync('sfs_1');
    });
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/publish', { note: 'Spring sale' });
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/publish', {});
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/versions/sfv_2/restore', {});
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/versions/sfv_2/copy-to-draft', {});
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/preview', {});
    expect(keys()).toContainEqual(onlineStoreKeys.versions('sfs_1'));
    expect(keys()).toContainEqual(onlineStoreKeys.sites());
    // The copied draft lands in the cache, so the editor can load it.
    expect(client.getQueryData(onlineStoreKeys.site('sfs_1'))).toEqual(copied);
  });
});

describe('content', () => {
  it('creates, updates and deletes pages', async () => {
    const keys = invalidated();
    const { result } = renderHook(
      () => ({ create: useCreateStorePage(), update: useUpdateStorePage(), remove: useDeleteStorePage() }),
      { wrapper },
    );
    await act(async () => {
      await result.current.create.mutateAsync({ siteId: 'sfs_1', data: { title: 'About us', slug: 'about', sections: [] } });
      await result.current.update.mutateAsync({ siteId: 'sfs_1', pageId: 'pg_1', data: { visible: false } });
      await result.current.remove.mutateAsync({ siteId: 'sfs_1', pageId: 'pg_1' });
    });
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/pages', { title: 'About us', slug: 'about', sections: [] });
    expect(api.patch).toHaveBeenCalledWith('/online-store/sites/sfs_1/pages/pg_1', { visible: false });
    expect(api.delete).toHaveBeenCalledWith('/online-store/sites/sfs_1/pages/pg_1');
    expect(keys()).toContainEqual(onlineStoreKeys.pages('sfs_1'));
    expect(keys()).toContainEqual(onlineStoreKeys.siteList());
  });

  it('saves and deletes menus by handle, and adds and deletes redirects', async () => {
    const keys = invalidated();
    const { result } = renderHook(
      () => ({
        save: useSaveStoreMenu(),
        removeMenu: useDeleteStoreMenu(),
        addRedirect: useCreateStoreRedirect(),
        removeRedirect: useDeleteStoreRedirect(),
      }),
      { wrapper },
    );
    const items = [{ id: 'm1', label: 'Shop', link: { type: 'catalog' as const } }];
    await act(async () => {
      await result.current.save.mutateAsync({ siteId: 'sfs_1', handle: 'main', data: { title: 'Main menu', items } });
      await result.current.removeMenu.mutateAsync({ siteId: 'sfs_1', handle: 'sidebar' });
      await result.current.addRedirect.mutateAsync({ siteId: 'sfs_1', data: { fromPath: '/old', toPath: '/new' } });
      await result.current.removeRedirect.mutateAsync({ siteId: 'sfs_1', redirectId: 'rd_1' });
    });
    expect(api.put).toHaveBeenCalledWith('/online-store/sites/sfs_1/menus/main', { title: 'Main menu', items });
    expect(api.delete).toHaveBeenCalledWith('/online-store/sites/sfs_1/menus/sidebar');
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/redirects', { fromPath: '/old', toPath: '/new' });
    expect(api.delete).toHaveBeenCalledWith('/online-store/sites/sfs_1/redirects/rd_1');
    expect(keys()).toContainEqual(onlineStoreKeys.menus('sfs_1'));
    expect(keys()).toContainEqual(onlineStoreKeys.redirects('sfs_1'));
  });
});

describe('deployments', () => {
  it('uploads files as multipart parts named by their path, with the config, then promotes and deletes', async () => {
    const keys = invalidated();
    const { result } = renderHook(
      () => ({ upload: useUploadDeployment(), promote: usePromoteDeployment(), remove: useDeleteDeployment() }),
      { wrapper },
    );
    const index = new Blob(['<html></html>'], { type: 'text/html' });
    const script = new Blob(['console.info(1)'], { type: 'text/javascript' });
    const config = new Blob(['{"spa":true}'], { type: 'application/json' });
    await act(async () => {
      await result.current.upload.mutateAsync({
        siteId: 'sfs_1',
        files: [
          { path: 'index.html', file: index },
          { path: 'assets/app.js', file: script },
        ],
        config,
      });
      await result.current.promote.mutateAsync({ siteId: 'sfs_1', deploymentId: 'dep_1' });
      await result.current.remove.mutateAsync({ siteId: 'sfs_1', deploymentId: 'dep_2' });
    });
    const [path, form] = api.postForm.mock.calls[0] as [string, FormData];
    expect(path).toBe('/online-store/sites/sfs_1/deployments');
    const files = form.getAll('files') as File[];
    expect(files.map((file) => file.name)).toEqual(['index.html', 'assets/app.js']);
    expect((form.get('config') as File).name).toBe('weldstorefront.json');
    expect(api.post).toHaveBeenCalledWith('/online-store/sites/sfs_1/deployments/dep_1/promote', {});
    expect(api.delete).toHaveBeenCalledWith('/online-store/sites/sfs_1/deployments/dep_2');
    expect(keys()).toContainEqual(onlineStoreKeys.deployments('sfs_1'));
  });
});

describe('hosts', () => {
  it('claims the free address, adds a domain, refreshes, makes primary and removes, refreshing that site\'s hosts', async () => {
    const keys = invalidated();
    const { result } = renderHook(
      () => ({
        create: useCreateStorefrontHost(),
        refresh: useRefreshStorefrontHost(),
        primary: useMakeStorefrontHostPrimary(),
        remove: useDeleteStorefrontHost(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.create.mutateAsync({ siteId: 'sfs_1', subdomain: 'myshop' });
      await result.current.create.mutateAsync({ siteId: 'sfs_1', hostname: 'shop.example.com' });
      await result.current.refresh.mutateAsync({ siteId: 'sfs_1', hostId: 'sfh_1' });
      await result.current.primary.mutateAsync({ siteId: 'sfs_1', hostId: 'sfh_1' });
      await result.current.remove.mutateAsync({ siteId: 'sfs_1', hostId: 'sfh_1' });
    });
    expect(api.post).toHaveBeenCalledWith('/storefront-hosts', { siteId: 'sfs_1', subdomain: 'myshop' });
    expect(api.post).toHaveBeenCalledWith('/storefront-hosts', { siteId: 'sfs_1', hostname: 'shop.example.com' });
    expect(api.post).toHaveBeenCalledWith('/storefront-hosts/sfh_1/refresh', {});
    expect(api.post).toHaveBeenCalledWith('/storefront-hosts/sfh_1/primary', {});
    expect(api.delete).toHaveBeenCalledWith('/storefront-hosts/sfh_1');
    expect(keys()).toContainEqual(onlineStoreKeys.hosts('sfs_1'));
    expect(keys()).toContainEqual(onlineStoreKeys.sites());
  });
});

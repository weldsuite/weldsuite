import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

// --- Mocks ----------------------------------------------------------------
// The provider reads permissions from `projectsApi.getPermissions` and error
// strings from `useTranslations`. Mock both so the test drives the fetch timing.

type PermissionsPayload = { role: string | null; canRead: boolean; canWrite: boolean; isAdmin: boolean };
type PermissionsResult = { success: boolean; data?: PermissionsPayload; error?: string };

const getPermissions = vi.fn<(projectId: string) => Promise<PermissionsResult>>();

vi.mock('@/app/weldflow/lib/api-client', () => ({
  projectsApi: { getPermissions: (projectId: string) => getPermissions(projectId) },
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  ProjectPermissionProvider,
  useProjectPermissions,
} from './project-permission-context';

const viewer: PermissionsPayload = { role: 'viewer', canRead: true, canWrite: false, isAdmin: false };
const member: PermissionsPayload = { role: 'member', canRead: true, canWrite: true, isAdmin: false };
const admin: PermissionsPayload = { role: 'admin', canRead: true, canWrite: true, isAdmin: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let refetchFn: () => Promise<void>;

function Probe() {
  const ctx = useProjectPermissions();
  refetchFn = ctx.refetch;
  return (
    <div>
      <span data-testid="loading">{String(ctx.isLoading)}</span>
      <span data-testid="canRead">{String(ctx.canRead)}</span>
      <span data-testid="canWrite">{String(ctx.canWrite)}</span>
      <span data-testid="isAdmin">{String(ctx.isAdmin)}</span>
      <span data-testid="isViewer">{String(ctx.isViewer)}</span>
      <span data-testid="role">{ctx.role ?? 'none'}</span>
      <span data-testid="error">{ctx.error ?? 'none'}</span>
    </div>
  );
}

function renderProvider(projectId = 'p1') {
  const view = render(
    <ProjectPermissionProvider projectId={projectId}>
      <Probe />
    </ProjectPermissionProvider>,
  );
  return {
    ...view,
    switchTo: (next: string) =>
      view.rerender(
        <ProjectPermissionProvider projectId={next}>
          <Probe />
        </ProjectPermissionProvider>,
      ),
  };
}

const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProjectPermissionProvider', () => {
  it('is read-only while permissions are loading', async () => {
    const pending = deferred<PermissionsResult>();
    getPermissions.mockReturnValue(pending.promise);

    renderProvider();

    expect(text('loading')).toBe('true');
    expect(text('canRead')).toBe('false');
    expect(text('canWrite')).toBe('false');
    expect(text('isAdmin')).toBe('false');
    expect(text('isViewer')).toBe('false');

    await act(async () => {
      pending.resolve({ success: true, data: member });
    });
    await waitFor(() => expect(text('loading')).toBe('false'));
  });

  it('exposes a loaded viewer as read-only', async () => {
    getPermissions.mockResolvedValue({ success: true, data: viewer });

    renderProvider();

    await waitFor(() => expect(text('loading')).toBe('false'));
    expect(text('canRead')).toBe('true');
    expect(text('canWrite')).toBe('false');
    expect(text('isAdmin')).toBe('false');
    expect(text('isViewer')).toBe('true');
    expect(text('role')).toBe('viewer');
  });

  it('lets a loaded member write', async () => {
    getPermissions.mockResolvedValue({ success: true, data: member });

    renderProvider();

    await waitFor(() => expect(text('canWrite')).toBe('true'));
    expect(text('isViewer')).toBe('false');
    expect(text('isAdmin')).toBe('false');
  });

  it('does not treat a workspace admin holding a viewer row as a viewer', async () => {
    getPermissions.mockResolvedValue({ success: true, data: { ...admin, role: 'viewer' } });

    renderProvider();

    await waitFor(() => expect(text('canWrite')).toBe('true'));
    expect(text('isViewer')).toBe('false');
    expect(text('isAdmin')).toBe('true');
  });

  it('falls back to read-only when the API reports a failure', async () => {
    getPermissions.mockResolvedValue({ success: false, error: 'boom' });

    renderProvider();

    await waitFor(() => expect(text('loading')).toBe('false'));
    expect(text('canRead')).toBe('false');
    expect(text('canWrite')).toBe('false');
    expect(text('isAdmin')).toBe('false');
    expect(text('error')).toBe('boom');
  });

  it('falls back to read-only when the request throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPermissions.mockRejectedValue(new Error('network'));

    renderProvider();

    await waitFor(() => expect(text('loading')).toBe('false'));
    expect(text('canWrite')).toBe('false');
    expect(text('isAdmin')).toBe('false');
    expect(text('error')).toBe('sweep.weldflow.permissionContext.loadFailed');
    consoleError.mockRestore();
  });

  it('keeps the previous permissions during a refetch for the same project', async () => {
    getPermissions.mockResolvedValueOnce({ success: true, data: member });
    renderProvider();
    await waitFor(() => expect(text('canWrite')).toBe('true'));

    const refetching = deferred<PermissionsResult>();
    getPermissions.mockReturnValueOnce(refetching.promise);
    act(() => { void refetchFn(); });

    await waitFor(() => expect(text('loading')).toBe('true'));
    expect(text('canWrite')).toBe('true');
    expect(text('role')).toBe('member');

    await act(async () => {
      refetching.resolve({ success: true, data: viewer });
    });
    await waitFor(() => expect(text('loading')).toBe('false'));
    expect(text('canWrite')).toBe('false');
    expect(text('isViewer')).toBe('true');
  });

  it('resets to read-only when the project changes', async () => {
    getPermissions.mockResolvedValueOnce({ success: true, data: member });
    const { switchTo } = renderProvider('p1');
    await waitFor(() => expect(text('canWrite')).toBe('true'));

    const next = deferred<PermissionsResult>();
    getPermissions.mockReturnValueOnce(next.promise);
    switchTo('p2');

    expect(text('canWrite')).toBe('false');
    expect(text('loading')).toBe('true');

    await act(async () => {
      next.resolve({ success: true, data: viewer });
    });
    await waitFor(() => expect(text('loading')).toBe('false'));
    expect(text('canWrite')).toBe('false');
    expect(text('isViewer')).toBe('true');
    expect(getPermissions).toHaveBeenLastCalledWith('p2');
  });

  it('ignores a slow response for a project the user already left', async () => {
    const slow = deferred<PermissionsResult>();
    getPermissions.mockReturnValueOnce(slow.promise);
    const { switchTo } = renderProvider('p1');

    getPermissions.mockResolvedValueOnce({ success: true, data: viewer });
    switchTo('p2');
    await waitFor(() => expect(text('isViewer')).toBe('true'));

    await act(async () => {
      slow.resolve({ success: true, data: admin });
    });

    expect(text('canWrite')).toBe('false');
    expect(text('isAdmin')).toBe('false');
    expect(text('isViewer')).toBe('true');
  });
});

describe('useProjectPermissions outside a provider', () => {
  it('returns the read-only default instead of throwing', () => {
    render(<Probe />);

    expect(text('canWrite')).toBe('false');
    expect(text('isAdmin')).toBe('false');
    expect(text('loading')).toBe('true');
  });
});

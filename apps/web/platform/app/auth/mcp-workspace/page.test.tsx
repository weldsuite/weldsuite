import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import type { McpWorkspaceSelection } from '@weldsuite/app-api-client/schemas/mcp-workspace-selections';

const auth = vi.hoisted(() => ({
  state: { isLoaded: true, isSignedIn: true },
  redirectToSignIn: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => auth.state,
  usesHostedSignIn: () => true,
  redirectToSignIn: auth.redirectToSignIn,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), decide: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ mcpWorkspaceSelections: api }),
}));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import McpWorkspacePage from './page';

const assign = vi.fn();
// jsdom's own Location: each visit navigates it, then stubs `assign` on a copy.
const realLocation = window.location;

function selection(overrides: Partial<McpWorkspaceSelection> = {}): McpWorkspaceSelection {
  return {
    client: { name: 'Claude', host: 'claude.ai' },
    workspaces: [
      { id: 'ws_a', name: 'Acme', slug: 'acme' },
      { id: 'ws_b', name: 'Beta', slug: 'beta' },
    ],
    suggestedWorkspaceId: null,
    ...overrides,
  };
}

function visit(search: string) {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  window.history.pushState({}, '', `/auth/mcp-workspace${search}`);
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
  return renderWithProviders(<McpWorkspacePage />);
}

beforeAll(() => {
  installPointerPolyfills();
});

beforeEach(() => {
  auth.state = { isLoaded: true, isSignedIn: true };
  auth.redirectToSignIn.mockReset();
  api.get.mockReset();
  api.decide.mockReset();
  api.decide.mockResolvedValue({ data: { redirectTo: 'https://auth.example.eu/tenant?ar=ar_1' } });
  assign.mockReset();
});

describe('McpWorkspacePage', () => {
  it('asks which workspace and sends the browser on with the choice', async () => {
    api.get.mockResolvedValue({ data: selection() });
    visit('?challenge=wtc_1');

    expect(await screen.findByRole('heading', { name: 'Choose a workspace' })).toBeTruthy();
    expect(screen.getByText('Claude wants to use WeldSuite. Choose the workspace it may work in.')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('wtc_1');

    await userEvent.click(screen.getByRole('radio', { name: /Beta/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.example.eu/tenant?ar=ar_1'));
    expect(api.decide).toHaveBeenCalledWith('wtc_1', { workspaceId: 'ws_b' });
  });

  it('says to choose one rather than sending nothing', async () => {
    api.get.mockResolvedValue({ data: selection() });
    visit('?challenge=wtc_1');

    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('alert').textContent).toBe('Choose a workspace to continue.');
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('goes on without asking when there is nothing to choose', async () => {
    api.get.mockResolvedValue({
      data: selection({ workspaces: [{ id: 'ws_a', name: 'Acme', slug: 'acme' }], suggestedWorkspaceId: 'ws_a' }),
    });
    visit('?challenge=wtc_1');

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.example.eu/tenant?ar=ar_1'));
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledWith('wtc_1', { workspaceId: 'ws_a' });
    expect(screen.queryByRole('heading', { name: 'Choose a workspace' })).toBeNull();
  });

  it('lets the person decline', async () => {
    api.get.mockResolvedValue({ data: selection() });
    visit('?challenge=wtc_1');

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('wtc_1', { decision: 'deny' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });

  it('says a used or expired link has expired', async () => {
    api.get.mockRejectedValue(new ApiError('Workspace selection not found', 404));
    visit('?challenge=wtc_gone');

    expect(await screen.findByText('This link has expired')).toBeTruthy();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('says the link has expired without a challenge, and asks nothing', () => {
    visit('');

    expect(screen.getByText('This link has expired')).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('signs a signed-out visitor in first and comes back here', async () => {
    auth.state = { isLoaded: true, isSignedIn: false };
    visit('?challenge=wtc_1');

    await waitFor(() =>
      expect(auth.redirectToSignIn).toHaveBeenCalledWith({ returnTo: '/auth/mcp-workspace?challenge=wtc_1' }),
    );
    expect(api.get).not.toHaveBeenCalled();
  });
});

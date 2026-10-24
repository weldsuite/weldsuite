import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { SignEnvelopeSummary } from '@weldsuite/app-api-client/schemas/weldsign';
import WeldSignHome from './page';

const state = vi.hoisted(() => ({
  canCreate: true,
  envelopes: [] as unknown[],
  folders: [] as string[],
  push: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/components/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/hooks/queries/use-weldsign-queries', () => ({
  useSignEnvelopes: (folder: string) => {
    state.folders.push(folder);
    return { envelopes: state.envelopes, isLoading: false, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() };
  },
  useCreateSignEnvelope: () => ({ mutateAsync: state.create }),
  useDeleteSignEnvelope: () => ({ mutateAsync: vi.fn() }),
}));

// The real list needs the whole app shell; this stand-in renders what the page hands it.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: (props: {
    items: { id: string }[];
    columns: { id: string; render: (item: never) => ReactNode }[];
    leftActionButtons?: ReactNode;
    createButton?: { label: string; onClick: () => void };
    emptyState: { title: string; description?: string; action?: { label: string; onClick: () => void } };
  }) => (
    <div>
      {props.leftActionButtons}
      {props.createButton && <button onClick={props.createButton.onClick}>{props.createButton.label}</button>}
      {props.items.length === 0 && (
        <div data-testid="empty">
          <p>{props.emptyState.title}</p>
          <p>{props.emptyState.description}</p>
          {props.emptyState.action && <button onClick={props.emptyState.action.onClick}>{props.emptyState.action.label}</button>}
        </div>
      )}
      {props.items.map((item) => (
        <div key={item.id} data-testid="row">
          {props.columns.map((col) => (
            <span key={col.id}>{col.render(item as never)}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

const th = en.weldsign.home;

function envelope(overrides: Partial<SignEnvelopeSummary> = {}): SignEnvelopeSummary {
  return {
    id: 'sgn_1',
    title: 'Service agreement',
    status: 'draft',
    senderUserId: 'user_1',
    senderName: 'Gert',
    documentCount: 2,
    recipients: { signers: 3, signed: 0, cc: 1 },
    recipientPreview: ['Ann', 'Bob', 'Carl'],
    sentAt: null,
    completedAt: null,
    expiresAt: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('WeldSign home', () => {
  beforeEach(() => {
    state.canCreate = true;
    state.envelopes = [];
    state.folders = [];
    state.push.mockReset();
    state.create.mockReset();
  });

  it('shows the empty state', () => {
    render(<WeldSignHome />);
    expect(screen.getByText(th.emptyTitle)).toBeTruthy();
  });

  it('lists requests with their status, recipients and document count', () => {
    state.envelopes = [envelope()];
    render(<WeldSignHome />);
    expect(screen.getByText('Service agreement')).toBeTruthy();
    expect(screen.getByText(en.weldsign.status.draft)).toBeTruthy();
    expect(screen.getByText('Ann, Bob, Carl')).toBeTruthy();
    expect(screen.getByText('+1 more')).toBeTruthy();
    expect(screen.getByText('2 PDFs')).toBeTruthy();
  });

  it('switches folders', () => {
    render(<WeldSignHome />);
    fireEvent.click(screen.getByRole('tab', { name: th.folders.completed }));
    expect(state.folders.at(-1)).toBe('completed');
  });

  it('puts "Action required" second, after "All"', () => {
    render(<WeldSignHome />);
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs.slice(0, 3)).toEqual([th.folders.all, th.folders.action_required, th.folders.drafts]);
    expect(th.folders.action_required).toBe('Action required');
  });

  it('asks the server for the action required folder', () => {
    render(<WeldSignHome />);
    fireEvent.click(screen.getByRole('tab', { name: th.folders.action_required }));
    expect(state.folders.at(-1)).toBe('action_required');
    expect(screen.getByRole('tab', { name: th.folders.action_required }).getAttribute('aria-selected')).toBe('true');
  });

  it('explains an empty action required folder, without offering to create a request', () => {
    render(<WeldSignHome />);
    fireEvent.click(screen.getByRole('tab', { name: th.folders.action_required }));
    expect(screen.getByText(th.actionRequiredEmptyTitle)).toBeTruthy();
    expect(screen.getByText(th.actionRequiredEmptyDescription)).toBeTruthy();
    expect(screen.queryByText(th.emptyTitle)).toBeNull();
    // The only "New request" button left is the one in the toolbar, none in the empty state.
    expect(screen.getAllByRole('button', { name: th.newRequest })).toHaveLength(1);
  });

  it('offers a new request in the empty "All" folder only', () => {
    render(<WeldSignHome />);
    expect(screen.getAllByRole('button', { name: th.newRequest })).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: th.folders.drafts }));
    expect(screen.getByText(th.noResultsTitle)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: th.newRequest })).toHaveLength(1);
  });

  it('creates a draft and opens it', async () => {
    state.create.mockResolvedValue({ id: 'sgn_new' });
    render(<WeldSignHome />);
    fireEvent.click(screen.getAllByRole('button', { name: th.newRequest })[0]!);
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldsign/sgn_new'));
    expect(state.create).toHaveBeenCalledWith({ title: th.untitled });
  });

  it('hides "New request" without sign_envelopes:create', () => {
    state.canCreate = false;
    render(<WeldSignHome />);
    expect(screen.queryByRole('button', { name: th.newRequest })).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { SignTemplateSummary } from '@weldsuite/app-api-client/schemas/weldsign';
import WeldSignTemplates from './page';

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  templates: [] as unknown[],
  searches: [] as string[],
  readEnabled: [] as boolean[],
  push: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: { open: boolean; title: string; description: string; onConfirm: () => void | Promise<void> }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        <p>{props.description}</p>
        <button onClick={() => void props.onConfirm()}>confirm delete</button>
      </div>
    ) : null,
}));
vi.mock('./use-template-dialog', () => ({
  UseTemplateDialog: (props: { templateId: string | null }) => (props.templateId ? <div role="dialog" aria-label="use dialog">{props.templateId}</div> : null),
}));
vi.mock('@/hooks/queries/use-weldsign-queries', () => ({
  useSignTemplates: (search: string, enabled: boolean) => {
    state.searches.push(search);
    state.readEnabled.push(enabled);
    return { templates: state.templates, isLoading: false, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() };
  },
  useCreateSignTemplate: () => ({ mutateAsync: state.create }),
  useDeleteSignTemplate: () => ({ mutateAsync: state.remove }),
}));

// The real list needs the whole app shell; this stand-in renders what the page hands it.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: (props: {
    items: { id: string }[];
    columns: { id: string; render: (item: never) => ReactNode }[];
    createButton?: { label: string; onClick: () => void };
    onRowClick?: (item: never) => void;
    onEdit?: (item: never) => void;
    onDelete?: (item: never) => void;
    emptyState: { title: string; description?: string; action?: { label: string; onClick: () => void } };
  }) => (
    <div>
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
          <button onClick={() => props.onRowClick?.(item as never)}>open {item.id}</button>
          {props.onEdit && <button onClick={() => props.onEdit?.(item as never)}>edit {item.id}</button>}
          {props.onDelete && <button onClick={() => props.onDelete?.(item as never)}>delete {item.id}</button>}
          {props.columns.map((col) => (
            <span key={col.id}>{col.render(item as never)}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

const tt = en.weldsign.templates;

function template(overrides: Partial<SignTemplateSummary> = {}): SignTemplateSummary {
  return {
    id: 'sgt_1',
    title: 'Service agreement',
    documentCount: 2,
    roles: [
      { id: 'sgr_1', roleName: 'Client', role: 'signer' },
      { id: 'sgr_2', roleName: 'Director', role: 'signer' },
      { id: 'sgr_3', roleName: 'Accountant', role: 'cc' },
      { id: 'sgr_4', roleName: 'Witness', role: 'signer' },
    ],
    createdByName: 'Gert',
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

const ALL = ['sign_templates:read', 'sign_templates:create', 'sign_templates:update', 'sign_templates:delete', 'sign_envelopes:create'];

beforeEach(() => {
  state.permissions = new Set(ALL);
  state.templates = [];
  state.searches = [];
  state.readEnabled = [];
  state.push.mockReset();
  state.create.mockReset();
  state.remove.mockReset();
});

describe('WeldSign templates list', () => {
  it('shows the empty state with a way to start the first template', () => {
    render(<WeldSignTemplates />);
    expect(screen.getByText(tt.emptyTitle)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: tt.newTemplate })).toHaveLength(2);
  });

  it('lists title, roles, document count and who made it', () => {
    state.templates = [template()];
    render(<WeldSignTemplates />);
    expect(screen.getByText('Service agreement')).toBeTruthy();
    expect(screen.getByText('Client')).toBeTruthy();
    expect(screen.getByText('Director')).toBeTruthy();
    expect(screen.getByText('Accountant')).toBeTruthy();
    // Three chips, the rest collapse.
    expect(screen.queryByText('Witness')).toBeNull();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('2 PDFs')).toBeTruthy();
    expect(screen.getByText('Gert')).toBeTruthy();
  });

  it('says so for a template without roles', () => {
    state.templates = [template({ roles: [] })];
    render(<WeldSignTemplates />);
    expect(screen.getByText(tt.noRoles)).toBeTruthy();
  });

  it('opens a template when its row is clicked', () => {
    state.templates = [template()];
    render(<WeldSignTemplates />);
    fireEvent.click(screen.getByRole('button', { name: 'open sgt_1' }));
    expect(state.push).toHaveBeenCalledWith('/weldsign/templates/sgt_1');
  });

  describe('New template', () => {
    it('creates a template and opens it', async () => {
      state.create.mockResolvedValue({ id: 'sgt_new' });
      render(<WeldSignTemplates />);
      fireEvent.click(screen.getAllByRole('button', { name: tt.newTemplate })[0]!);
      await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldsign/templates/sgt_new'));
      expect(state.create).toHaveBeenCalledWith({ title: tt.untitled });
    });

    it('is hidden without sign_templates:create', () => {
      state.permissions.delete('sign_templates:create');
      render(<WeldSignTemplates />);
      expect(screen.queryByRole('button', { name: tt.newTemplate })).toBeNull();
    });
  });

  describe('Use', () => {
    it('opens the Use template dialog for that template', () => {
      state.templates = [template()];
      render(<WeldSignTemplates />);
      fireEvent.click(screen.getByRole('button', { name: 'Use Service agreement' }));
      expect(screen.getByRole('dialog', { name: 'use dialog' }).textContent).toBe('sgt_1');
    });

    it('is hidden without the right to make requests', () => {
      state.permissions.delete('sign_envelopes:create');
      state.templates = [template()];
      render(<WeldSignTemplates />);
      expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
    });

    it.each([
      ['no document', { documentCount: 0 }],
      ['no role', { roles: [] }],
    ])('is disabled, with the reason, for a template with %s', (_label, overrides) => {
      state.templates = [template(overrides)];
      render(<WeldSignTemplates />);
      const use = screen.getByRole('button', { name: 'Use Service agreement' }) as HTMLButtonElement;
      expect(use.disabled).toBe(true);
      expect(use.title).toBe(tt.cannotUse);
    });
  });

  describe('row menu', () => {
    it('offers Edit and Delete with sign_templates:update and :delete', () => {
      state.templates = [template()];
      render(<WeldSignTemplates />);
      expect(screen.getByRole('button', { name: 'edit sgt_1' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'delete sgt_1' })).toBeTruthy();
    });

    it('hides Edit without sign_templates:update, and Delete without :delete', () => {
      state.permissions.delete('sign_templates:update');
      state.permissions.delete('sign_templates:delete');
      state.templates = [template()];
      render(<WeldSignTemplates />);
      expect(screen.queryByRole('button', { name: 'edit sgt_1' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'delete sgt_1' })).toBeNull();
    });

    it('opens the editor from Edit', () => {
      state.templates = [template()];
      render(<WeldSignTemplates />);
      fireEvent.click(screen.getByRole('button', { name: 'edit sgt_1' }));
      expect(state.push).toHaveBeenCalledWith('/weldsign/templates/sgt_1');
    });

    it('asks before deleting, then deletes', async () => {
      state.remove.mockResolvedValue(undefined);
      state.templates = [template()];
      render(<WeldSignTemplates />);

      fireEvent.click(screen.getByRole('button', { name: 'delete sgt_1' }));
      const dialog = screen.getByRole('dialog', { name: tt.delete.title });
      expect(dialog.textContent).toContain('"Service agreement" and its documents will be deleted.');
      expect(state.remove).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'confirm delete' }));
      await waitFor(() => expect(state.remove).toHaveBeenCalledWith('sgt_1'));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: tt.delete.title })).toBeNull());
    });
  });

  it('does not ask for templates, and says so, without sign_templates:read', () => {
    state.permissions.delete('sign_templates:read');
    render(<WeldSignTemplates />);
    expect(screen.getByText(tt.noAccess)).toBeTruthy();
    expect(state.readEnabled.every((enabled) => enabled === false)).toBe(true);
  });
});

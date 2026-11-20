import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import type { FormEditor, SaveState } from './editor-context';
import FormShell from './shell';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ formId: 'frm_1' }),
}));

let pathname = '/weldforms/frm_1/edit';
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => pathname,
}));

const breadcrumbs = vi.fn();
vi.mock('@/contexts/breadcrumb-context', () => ({
  useBreadcrumbs: (items: unknown, options: unknown) => breadcrumbs(items, options),
}));

interface QueryState {
  data: FormDetail | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}
let query: QueryState;
vi.mock('@/hooks/queries/use-weldforms-queries', () => ({
  useForm: () => query,
}));

let editor: FormEditor;
vi.mock('./editor-context', () => ({
  FormEditorProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useFormEditor: () => editor,
}));

vi.mock('./form-actions', () => ({
  FormActions: () => <div>form actions</div>,
}));

vi.mock('@/components/shared/inline-text-editor', () => ({
  InlineTextEditor: ({ value, onSave, label }: { value: string; onSave: (next: string) => void; label?: string }) => (
    <div>
      <span>{value}</span>
      <button type="button" onClick={() => onSave('  '.trim() + 'x'.repeat(300))}>
        {label} long
      </button>
      <button type="button" onClick={() => onSave('New title')}>
        {label} save
      </button>
      <button type="button" onClick={() => onSave('')}>
        {label} empty
      </button>
    </div>
  ),
}));

const permissions = { edit: true, publish: true, delete: true, send: true, readResponses: true, exportResponses: true, deleteResponses: true, manageAccess: true };

function makeForm(over: Partial<FormDetail> = {}, perms: Partial<typeof permissions> = {}): FormDetail {
  return { id: 'frm_1', title: 'Survey', status: 'draft', hasUnpublishedChanges: false, permissions: { ...permissions, ...perms }, ...over } as unknown as FormDetail;
}

function makeEditor(form: FormDetail, over: { canEdit?: boolean; saveState?: SaveState; title?: string } = {}): FormEditor {
  return {
    form,
    draft: { title: over.title ?? form.title },
    canEdit: over.canEdit ?? form.permissions.edit,
    saveState: over.saveState ?? 'saved',
    setTitle: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
  } as unknown as FormEditor;
}

function setForm(form: FormDetail, over: Parameters<typeof makeEditor>[1] = {}) {
  query = { data: form, isLoading: false, error: null, refetch: vi.fn() };
  editor = makeEditor(form, over);
}

describe('FormShell', () => {
  beforeEach(() => {
    pathname = '/weldforms/frm_1/edit';
    breadcrumbs.mockClear();
    setForm(makeForm());
  });

  it('shows a loader while the form loads', () => {
    query = { data: undefined, isLoading: true, error: null, refetch: vi.fn() };
    render(<FormShell>child</FormShell>);
    expect(screen.queryByText('child')).toBeNull();
    expect(screen.queryByText('form actions')).toBeNull();
  });

  it('shows a not-found state with a link back on a 404', () => {
    query = { data: undefined, isLoading: false, error: new ApiError('nope', 404), refetch: vi.fn() };
    render(<FormShell>child</FormShell>);
    expect(screen.getByText(en.weldforms.shell.notFoundTitle)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.weldforms.shell.backToForms }).getAttribute('href')).toBe('/weldforms');
  });

  it('shows a retryable error otherwise', () => {
    const refetch = vi.fn();
    query = { data: undefined, isLoading: false, error: new Error('boom'), refetch };
    render(<FormShell>child</FormShell>);
    expect(screen.getByText(en.weldforms.loadFailed)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.retry }));
    expect(refetch).toHaveBeenCalled();
  });

  it('treats a missing form without an error as a load failure', () => {
    query = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
    render(<FormShell>child</FormShell>);
    expect(screen.getByText(en.weldforms.loadFailed)).toBeTruthy();
  });

  it('renders the header, status badge, actions, tabs and the page', () => {
    render(<FormShell>page content</FormShell>);
    expect(screen.getByRole('link', { name: en.weldforms.shell.backToForms }).getAttribute('href')).toBe('/weldforms');
    expect(screen.getByText('Survey')).toBeTruthy();
    expect(screen.getByText(en.weldforms.status.draft)).toBeTruthy();
    expect(screen.getByText('form actions')).toBeTruthy();
    expect(screen.getByText('page content')).toBeTruthy();
    for (const tab of ['edit', 'logic', 'design', 'settings', 'integrations', 'share', 'results'] as const) {
      expect(screen.getByRole('link', { name: en.weldforms.tabs[tab] }).getAttribute('href')).toBe(`/weldforms/frm_1/${tab}`);
    }
    expect(breadcrumbs).toHaveBeenCalledWith(
      [{ label: en.weldforms.breadcrumb.home, href: '/weldforms' }, { label: 'Survey' }],
      { enabled: true },
    );
  });

  it('marks the tab of the current path as active', () => {
    pathname = '/weldforms/frm_1/logic';
    render(<FormShell>x</FormShell>);
    const label = (name: string) => screen.getByRole('link', { name }).firstElementChild;
    expect(label(en.weldforms.tabs.logic)?.className).toContain('text-foreground');
    expect(label(en.weldforms.tabs.logic)?.className).not.toContain('text-muted-foreground');
    expect(label(en.weldforms.tabs.edit)?.className).toContain('text-muted-foreground');
  });

  it('falls back to the untitled label in the header and breadcrumb', () => {
    setForm(makeForm({ title: '' }), { title: '' });
    render(<FormShell>x</FormShell>);
    expect(screen.getByText(en.weldforms.untitled)).toBeTruthy();
    expect(breadcrumbs).toHaveBeenCalledWith(expect.arrayContaining([{ label: en.weldforms.untitled }]), expect.anything());
  });

  it('renames the form inline, trimming to 255 characters and ignoring an empty name', () => {
    render(<FormShell>x</FormShell>);
    fireEvent.click(screen.getByRole('button', { name: `${en.weldforms.shell.titleLabel} save` }));
    expect(editor.setTitle).toHaveBeenLastCalledWith('New title');
    fireEvent.click(screen.getByRole('button', { name: `${en.weldforms.shell.titleLabel} long` }));
    expect(vi.mocked(editor.setTitle).mock.calls.at(-1)?.[0]).toHaveLength(255);
    vi.mocked(editor.setTitle).mockClear();
    fireEvent.click(screen.getByRole('button', { name: `${en.weldforms.shell.titleLabel} empty` }));
    expect(editor.setTitle).not.toHaveBeenCalled();
  });

  it('shows a retry for a failed save and flushes on click', () => {
    setForm(makeForm(), { saveState: 'error' });
    render(<FormShell>x</FormShell>);
    fireEvent.click(screen.getByRole('button', { name: en.weldforms.editor.saveFailedRetry }));
    expect(editor.flush).toHaveBeenCalled();
  });

  it('shows no save indicator while saving or saved', () => {
    setForm(makeForm(), { saveState: 'saving' });
    render(<FormShell>x</FormShell>);
    expect(screen.queryByRole('button', { name: en.weldforms.editor.saveFailedRetry })).toBeNull();
  });

  it('shows the unpublished-changes badge on a published form', () => {
    setForm(makeForm({ status: 'published', hasUnpublishedChanges: true }));
    render(<FormShell>x</FormShell>);
    expect(screen.getByText(en.weldforms.status.published)).toBeTruthy();
    expect(screen.getByText(en.weldforms.status.unpublishedChanges)).toBeTruthy();
  });

  describe('read-only', () => {
    beforeEach(() => {
      setForm(makeForm({}, { edit: false, readResponses: false }), { canEdit: false, saveState: 'error' });
    });

    it('shows the title as a heading without an editor or save indicator', () => {
      render(<FormShell>x</FormShell>);
      expect(screen.getByRole('heading', { name: 'Survey' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: `${en.weldforms.shell.titleLabel} save` })).toBeNull();
      expect(screen.queryByRole('button', { name: en.weldforms.editor.saveFailedRetry })).toBeNull();
    });

    it('hides the integrations tab without edit rights and results without response access', () => {
      render(<FormShell>x</FormShell>);
      expect(screen.queryByRole('link', { name: en.weldforms.tabs.integrations })).toBeNull();
      expect(screen.queryByRole('link', { name: en.weldforms.tabs.results })).toBeNull();
      expect(screen.getByRole('link', { name: en.weldforms.tabs.share })).toBeTruthy();
    });
  });
});

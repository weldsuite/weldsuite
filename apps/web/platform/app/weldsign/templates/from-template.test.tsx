import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { SignTemplateSummary } from '@weldsuite/app-api-client/schemas/weldsign';

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  templates: [] as unknown[],
  /** What a search returns, where it differs from the whole list. */
  results: {} as Record<string, unknown[]>,
  calls: [] as { search: string; enabled: boolean }[],
  isLoading: false,
  isError: false,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('./use-template-dialog', () => ({
  UseTemplateDialog: (props: { templateId: string | null }) =>
    props.templateId ? <div role="dialog" aria-label="use template dialog">{props.templateId}</div> : null,
}));
vi.mock('@/hooks/queries/use-weldsign-queries', () => ({
  useSignTemplates: (search: string, enabled = true) => {
    state.calls.push({ search, enabled });
    return {
      templates: enabled ? (state.results[search] ?? state.templates) : [],
      isLoading: state.isLoading,
      isError: state.isError,
      hasNextPage: state.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: state.fetchNextPage,
    };
  },
}));

import { FromTemplateButton } from './from-template';

const tp = en.weldsign.templates.picker;

function template(overrides: Partial<SignTemplateSummary> = {}): SignTemplateSummary {
  return {
    id: 'sgt_1',
    title: 'Non-disclosure agreement',
    documentCount: 1,
    roles: [{ id: 'sgr_1', roleName: 'Client', role: 'signer' }],
    createdByName: 'Gert',
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

function renderButton() {
  render(
    <I18nProvider initialLanguage="en">
      <FromTemplateButton />
    </I18nProvider>,
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
  state.permissions = new Set(['sign_templates:read', 'sign_envelopes:create']);
  state.templates = [template()];
  state.results = {};
  state.calls = [];
  state.isLoading = false;
  state.isError = false;
  state.hasNextPage = false;
  state.fetchNextPage.mockReset();
});

afterEach(() => cleanup());

describe('From template', () => {
  it('is offered when the member may read templates and make requests, and there are templates', () => {
    renderButton();
    expect(screen.getByRole('button', { name: tp.action })).toBeInTheDocument();
  });

  it('is hidden when there are no templates', () => {
    state.templates = [];
    renderButton();
    expect(screen.queryByRole('button', { name: tp.action })).toBeNull();
  });

  it.each(['sign_templates:read', 'sign_envelopes:create'])('is hidden without %s, and no template is asked for', (missing) => {
    state.permissions.delete(missing);
    renderButton();
    expect(screen.queryByRole('button', { name: tp.action })).toBeNull();
    expect(state.calls.every((call) => !call.enabled)).toBe(true);
  });

  it('lists the templates with their roles and document count', async () => {
    state.templates = [
      template(),
      template({ id: 'sgt_2', title: 'Employment contract', documentCount: 3, roles: [{ id: 'sgr_2', roleName: 'Employee', role: 'signer' }] }),
    ];
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: tp.action }));

    const dialog = screen.getByRole('dialog', { name: tp.title });
    expect(dialog).toHaveTextContent('Non-disclosure agreement');
    expect(dialog).toHaveTextContent('Employment contract');
    expect(dialog).toHaveTextContent('Employee');
    expect(dialog).toHaveTextContent('3 PDFs');
  });

  it('searches the templates', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: tp.action }));
    await user.type(screen.getByRole('searchbox', { name: tp.searchPlaceholder }), 'nda');
    expect(state.calls.some((call) => call.search === 'nda' && call.enabled)).toBe(true);
  });

  it('asks who fills each role once a template is picked, and closes the picker', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: tp.action }));
    await user.click(screen.getByRole('button', { name: /Non-disclosure agreement/ }));

    expect(screen.getByRole('dialog', { name: 'use template dialog' })).toHaveTextContent('sgt_1');
    expect(screen.queryByRole('dialog', { name: tp.title })).toBeNull();
  });

  it('cannot pick a template that cannot be used yet, and says why', async () => {
    state.templates = [template({ documentCount: 0 })];
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: tp.action }));
    const row = screen.getByRole('button', { name: /Non-disclosure agreement/ });
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute('title', en.weldsign.templates.cannotUse);
  });

  it('shows more templates on request', async () => {
    state.hasNextPage = true;
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: tp.action }));
    await user.click(screen.getByRole('button', { name: tp.loadMore }));
    expect(state.fetchNextPage).toHaveBeenCalled();
  });

  it('says so when a search finds nothing', async () => {
    const user = userEvent.setup();
    state.results = { zzz: [] };
    renderButton();
    await user.click(screen.getByRole('button', { name: tp.action }));
    await user.type(screen.getByRole('searchbox', { name: tp.searchPlaceholder }), 'zzz');
    expect(screen.getByText(tp.empty)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: tp.title })).toBeInTheDocument();
  });

  it('says so when the templates cannot be loaded', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: tp.action }));
    state.isError = true;
    await user.type(screen.getByRole('searchbox', { name: tp.searchPlaceholder }), 'a');
    expect(screen.getByText(tp.loadFailed)).toBeInTheDocument();
  });
});

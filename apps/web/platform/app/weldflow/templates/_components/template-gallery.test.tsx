import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';
import { ApiError } from '@weldsuite/api-client';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: en,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
  }),
}));

import { TemplateGallery } from './template-gallery';
import { makeTemplate } from '../_lib/test-fixtures';

function setup(props: Partial<Parameters<typeof TemplateGallery>[0]> = {}) {
  const handlers = { onRetry: vi.fn(), onSearchChange: vi.fn(), onSelect: vi.fn(), onSaveProject: vi.fn() };
  render(
    <TemplateGallery
      templates={[makeTemplate(), makeTemplate({ id: 'tpl_2', name: 'Onboarding', shared: false, usageCount: 0, description: null })]}
      isLoading={false}
      error={null}
      search=""
      selectedId="tpl_1"
      canManage
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('TemplateGallery', () => {
  it('shows a card per template with its meta line and badge', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Templates · 2' })).toBeInTheDocument();
    const selected = screen.getByRole('button', { name: /Website relaunch/ });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(selected).toHaveTextContent('20 weeks · 3 tasks · used 4 times');
    expect(selected).toHaveTextContent('Shared');
    expect(screen.getByRole('button', { name: /Onboarding/ })).toHaveTextContent('Only you');
    expect(screen.getByRole('button', { name: /Onboarding/ })).toHaveTextContent('not used yet');
  });

  it('selects a template and searches', async () => {
    const handlers = setup();
    await userEvent.click(screen.getByRole('button', { name: /Onboarding/ }));
    expect(handlers.onSelect).toHaveBeenCalledWith('tpl_2');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search templates' }), 'a');
    expect(handlers.onSearchChange).toHaveBeenCalledWith('a');
  });

  it('offers to save a project as a template only to managers', async () => {
    const handlers = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Save a project as template…' }));
    expect(handlers.onSaveProject).toHaveBeenCalled();
  });

  it('hides the save entry from everyone else', () => {
    setup({ canManage: false });
    expect(screen.queryByRole('button', { name: 'Save a project as template…' })).not.toBeInTheDocument();
  });

  it('explains an empty gallery differently to managers and members', () => {
    setup({ templates: [] });
    expect(screen.getByText(en.flowClosing.templates.gallery.emptyManage)).toBeInTheDocument();
  });

  it('tells a member to ask a manager', () => {
    setup({ templates: [], canManage: false });
    expect(screen.getByText(en.flowClosing.templates.gallery.emptyMember)).toBeInTheDocument();
  });

  it('says nothing matched a search', () => {
    setup({ templates: [], search: 'zzz' });
    expect(screen.getByText('No templates match your search')).toBeInTheDocument();
  });

  it('offers a retry on a failure and none on a 403', async () => {
    const handlers = setup({ templates: undefined, error: new ApiError('boom', 500) });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetry).toHaveBeenCalled();
  });

  it('shows the no-access state for a 403', () => {
    setup({ templates: undefined, error: new ApiError('no', 403) });
    expect(screen.getByRole('alert')).toHaveTextContent('No access to templates');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a loading state', () => {
    setup({ templates: undefined, isLoading: true });
    expect(screen.getByRole('status', { name: 'Loading templates' })).toBeInTheDocument();
  });
});

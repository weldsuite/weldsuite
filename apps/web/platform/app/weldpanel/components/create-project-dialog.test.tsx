import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { makeProject } from '../test-fixtures';
import { CreateProjectDialog } from './create-project-dialog';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  create: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale, format: interpolate }) };
});
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useCreateWeldPanelProject: () => ({ mutateAsync: state.create, isPending: false }),
}));

const td = en.weldpanel.createDialog;

function setup() {
  const onOpenChange = vi.fn();
  render(<CreateProjectDialog open onOpenChange={onOpenChange} />);
  return { user: userEvent.setup(), onOpenChange };
}

describe('CreateProjectDialog', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.create.mockReset();
    state.push.mockReset();
    state.toast.success.mockReset();
    state.toast.error.mockReset();
  });

  it('asks for a name before it creates anything', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: td.submit }));
    expect(await screen.findByText(en.weldpanel.validation.nameRequired)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('refuses a domain that is not a host and keeps it out of the list', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText(new RegExp(en.weldpanel.general.domainsLabel)), 'not a host{Enter}');
    expect(await screen.findByText(en.weldpanel.validation.domainInvalid)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('reduces a pasted address to its host and lists it once', async () => {
    const { user } = setup();
    const input = screen.getByLabelText(new RegExp(en.weldpanel.general.domainsLabel));
    await user.type(input, 'https://Example.com/pricing{Enter}');
    expect(screen.getByText('example.com')).toBeTruthy();
    await user.type(input, 'example.com{Enter}');
    expect(await screen.findByText(en.weldpanel.validation.domainDuplicate)).toBeTruthy();
    expect(screen.getAllByText('example.com')).toHaveLength(1);
  });

  it('creates the project and opens its install tab', async () => {
    state.create.mockResolvedValue(makeProject({ id: 'wpp_new' }));
    const { user, onOpenChange } = setup();

    await user.type(screen.getByLabelText(en.weldpanel.general.nameLabel), '  Shop  ');
    await user.click(screen.getByRole('radio', { name: new RegExp(en.weldpanel.kinds.app) }));
    await user.type(screen.getByLabelText(new RegExp(en.weldpanel.general.domainsLabel)), 'shop.example.com{Enter}');
    await user.click(screen.getByRole('button', { name: td.submit }));

    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create).toHaveBeenCalledWith({ name: 'Shop', kind: 'app', allowedDomains: ['shop.example.com'] });
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldpanel/projects/wpp_new'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(state.toast.success).toHaveBeenCalledWith(td.created);
  });

  it('takes a valid domain that was typed but not added when the form is submitted', async () => {
    state.create.mockResolvedValue(makeProject({ id: 'wpp_new' }));
    const { user } = setup();
    await user.type(screen.getByLabelText(en.weldpanel.general.nameLabel), 'Shop');
    await user.type(screen.getByLabelText(new RegExp(en.weldpanel.general.domainsLabel)), 'late.example.com');
    await user.click(screen.getByRole('button', { name: td.submit }));
    await waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create).toHaveBeenCalledWith({ name: 'Shop', kind: 'website', allowedDomains: ['late.example.com'] });
  });

  it('stays open and says so when the API refuses', async () => {
    state.create.mockRejectedValue(new Error('boom'));
    const { user, onOpenChange } = setup();
    await user.type(screen.getByLabelText(en.weldpanel.general.nameLabel), 'Shop');
    await user.click(screen.getByRole('button', { name: td.submit }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith(td.createFailed));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('speaks Dutch', async () => {
    state.locale = 'nl';
    const { user } = setup();
    expect(screen.getByText(nl.weldpanel.createDialog.title)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: nl.weldpanel.createDialog.submit }));
    expect(await screen.findByText(nl.weldpanel.validation.nameRequired)).toBeTruthy();
  });
});

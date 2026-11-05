import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';

// The list only needs the translations; the rest of the i18n provider is not under test.
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate }),
}));

import { StakeholderList } from './stakeholder-list';

function stakeholder(overrides: Partial<Stakeholder> = {}): Stakeholder {
  return {
    id: 'stk_1',
    projectId: 'prj_1',
    kind: 'member',
    memberId: 'user_1',
    crmContactId: null,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    organisation: 'Analytical Engines',
    role: 'Sponsor',
    influence: 5,
    interest: 4,
    attitude: 'supportive',
    engagement: 'leading',
    notes: null,
    lastContactAt: '2026-10-30T14:30:00.000Z',
    portalAccess: false,
    portalInvitedAt: null,
    createdBy: 'user_1',
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

const ada = stakeholder();
const grace = stakeholder({ id: 'stk_2', kind: 'contact', memberId: null, crmContactId: 'per_1', name: 'Grace Hopper', organisation: null, role: null, attitude: 'resistant', engagement: 'unaware', lastContactAt: null });

function setup(overrides: Partial<Parameters<typeof StakeholderList>[0]> = {}) {
  const props = {
    rows: [ada, grace],
    search: '',
    onSearchChange: vi.fn(),
    filters: [],
    onFiltersChange: vi.fn(),
    selectedId: null,
    avatarOf: () => null,
    canEdit: true,
    onOpen: vi.fn(),
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<StakeholderList {...props} />);
  return props;
}

describe('StakeholderList', () => {
  it('lists every stakeholder with the facts of its columns', () => {
    setup();
    const row = screen.getByRole('button', { name: 'Ada Lovelace' }).parentElement as HTMLElement;
    expect(within(row).getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(within(row).getByText('Sponsor')).toBeInTheDocument();
    expect(within(row).getByText('Analytical Engines')).toBeInTheDocument();
    expect(within(row).getByText('5 / 4')).toBeInTheDocument();
    expect(within(row).getByText(en.flowReporting.stakeholders.attitudes.supportive)).toBeInTheDocument();
    expect(within(row).getByText(en.flowReporting.stakeholders.engagements.leading)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grace Hopper' })).toBeInTheDocument();
  });

  it('heads the columns of the list', () => {
    setup();
    const copy = en.flowReporting.stakeholders;
    for (const header of [copy.columns.name, copy.form.role, copy.form.organisation, copy.columns.attitude, copy.columns.engagement, copy.columns.lastContact]) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
    expect(screen.getByText(`${copy.columns.influence} / ${copy.columns.interest}`)).toBeInTheDocument();
  });

  it('opens a stakeholder from anywhere on its row', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Grace Hopper' }));
    expect(props.onOpen).toHaveBeenCalledWith('stk_2');
  });

  it('marks the stakeholder whose panel is open', () => {
    setup({ selectedId: 'stk_2' });
    expect(screen.getByRole('button', { name: 'Grace Hopper' }).parentElement).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Ada Lovelace' }).parentElement).not.toHaveAttribute('aria-current');
  });

  it('edits and removes from the three-dot menu of a row', async () => {
    const props = setup();
    const copy = en.flowReporting.stakeholders;
    const menus = screen.getAllByRole('button', { name: copy.moreActions });
    expect(menus).toHaveLength(2);

    await userEvent.click(menus[0]);
    await userEvent.click(await screen.findByRole('menuitem', { name: en.flowGovernance.common.edit }));
    expect(props.onEdit).toHaveBeenCalledWith(ada);

    await userEvent.click(screen.getAllByRole('button', { name: copy.moreActions })[1]);
    await userEvent.click(await screen.findByRole('menuitem', { name: copy.form.remove }));
    expect(props.onRemove).toHaveBeenCalledWith(grace);
  });

  it('has no row menu for a member who may not edit', () => {
    setup({ canEdit: false });
    expect(screen.queryByRole('button', { name: en.flowReporting.stakeholders.moreActions })).not.toBeInTheDocument();
  });

  it('shows the illustrated empty state with an add button when nobody is on the register', async () => {
    const props = setup({ rows: [] });
    const copy = en.flowReporting.stakeholders;
    expect(screen.getByRole('heading', { name: copy.emptyTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.emptyDescription)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: copy.add }));
    expect(props.onAdd).toHaveBeenCalledTimes(1);
  });

  it('shows the read-only empty state without an add button', () => {
    setup({ rows: [], canEdit: false });
    const copy = en.flowReporting.stakeholders;
    expect(screen.getByText(copy.emptyReadOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.add })).not.toBeInTheDocument();
  });

  it('says nothing matches when a search leaves no rows', () => {
    setup({ rows: [], search: 'zzz' });
    const copy = en.flowReporting.stakeholders;
    expect(screen.getByRole('heading', { name: copy.noMatches })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: copy.emptyTitle })).not.toBeInTheDocument();
  });
});

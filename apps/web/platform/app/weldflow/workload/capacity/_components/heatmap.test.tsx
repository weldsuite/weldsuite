import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { CapacityResponse, MemberCapacity } from '@weldsuite/app-api-client/domains/flow-portfolio';

// The heatmap only needs the translations; the rest of the i18n provider is not under test.
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate }),
}));

import { Heatmap } from './heatmap';

const ann: MemberCapacity = {
  memberId: 'u_ann',
  weeklyHours: 40,
  skills: ['Backend', 'QA'],
  hasProfile: true,
  cells: [
    { hours: 30, tentativeHours: 8, percent: 75, band: 'ok' },
    { hours: 0, tentativeHours: 0, percent: 0, band: 'none' },
  ],
  projects: [
    { projectId: 'p_apollo', requestId: null, name: 'Apollo', accessible: true, hours: [22, 0], tentativeHours: [0, 0] },
    { projectId: 'p_secret', requestId: null, name: 'Secret', accessible: false, hours: [8, 0], tentativeHours: [8, 0] },
  ],
};

const bob: MemberCapacity = {
  memberId: 'u_bob',
  weeklyHours: 0,
  skills: ['backend'],
  hasProfile: false,
  cells: [
    { hours: 4, tentativeHours: 0, percent: null, band: 'critical' },
    { hours: 0, tentativeHours: 0, percent: null, band: 'none' },
  ],
  projects: [],
};

function loadOf(members: MemberCapacity[]): CapacityResponse {
  return {
    from: '2026-11-30',
    to: '2026-12-13',
    tentative: true,
    weeks: [
      { week: '2026-W49', startsOn: '2026-11-30', endsOn: '2026-12-06' },
      { week: '2026-W50', startsOn: '2026-12-07', endsOn: '2026-12-13' },
    ],
    totals: [
      { bookedHours: 34, capacityHours: 40 },
      { bookedHours: 0, capacityHours: 40 },
    ],
    members,
    summary: { memberCount: members.length, bookedHours: 34, capacityHours: 80, percent: 42.5, overbookedPersonWeeks: 0 },
  };
}

const names: Record<string, string> = { u_ann: 'Ann', u_bob: 'Bob' };

function setup(overrides: Partial<Parameters<typeof Heatmap>[0]> = {}) {
  const props = {
    load: loadOf([ann, bob]),
    groupBy: 'person' as const,
    canEdit: true,
    nameOf: (id: string) => names[id] ?? id,
    pictureOf: () => undefined,
    onEdit: vi.fn(),
    ...overrides,
  };
  render(<Heatmap {...props} />);
  return props;
}

const sidebar = () => document.querySelector<HTMLElement>('[data-roadmap-ui="gantt-sidebar"]')!;

describe('Heatmap', () => {
  it('lists people in the member list with their skills and contract hours', () => {
    setup();
    const list = within(sidebar());
    expect(list.getByText('Person')).toBeInTheDocument();
    expect(list.getByText('Contract hours')).toBeInTheDocument();
    const annRow = list.getByRole('button', { name: 'Show projects for Ann' });
    expect(annRow).toHaveAttribute('aria-expanded', 'false');
    expect(annRow).toHaveTextContent('Backend, QA');
    expect(annRow).toHaveTextContent('40 h/week');
    expect(list.getByRole('button', { name: 'Show projects for Bob' })).toHaveTextContent('0 h/week');
  });

  it('heads the weeks with their month and first day', () => {
    setup();
    expect(screen.getByText('November 2026')).toBeInTheDocument();
    expect(screen.getByText('December 2026')).toBeInTheDocument();
    expect(screen.getByTitle('2026-W49')).toHaveTextContent('30');
    expect(screen.getByTitle('2026-W50')).toHaveTextContent('7');
  });

  it('fills each week with its load and marks tentative hours', () => {
    setup();
    const tentative = screen.getByLabelText('75% booked, 30 h. Tentative included: 8 h');
    expect(tentative).toHaveTextContent('75%');
    expect(tentative.querySelector('span')).not.toBeNull();
    const noContract = screen.getByLabelText('4 h booked, no contract hours');
    expect(noContract).toHaveTextContent('4 h');
    expect(noContract.querySelector('span')).toBeNull();
    expect(screen.getByLabelText('0% booked, 0 h')).toHaveTextContent('–');
  });

  it('shows the projects behind a person, keeping the ones the viewer is not in anonymous', async () => {
    setup();
    expect(screen.queryByText('Apollo')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show projects for Ann' }));

    expect(screen.getByRole('button', { name: 'Hide projects for Ann' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(sidebar()).getByText('Apollo')).not.toHaveClass('italic');
    expect(within(sidebar()).getByText('Other project')).toHaveClass('italic');
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
    expect(screen.getByText('22 h')).toBeInTheDocument();
    expect(screen.getByText('8 h')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Hide projects for Ann' }));
    expect(screen.queryByText('Apollo')).not.toBeInTheDocument();
  });

  it('opens the profile of a person for those who may edit it', async () => {
    const { onEdit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Edit profile of Bob' }));
    expect(onEdit).toHaveBeenCalledWith('u_bob');
  });

  it('leaves out the edit buttons for everyone else', () => {
    setup({ canEdit: false });
    expect(screen.queryByRole('button', { name: /^Edit profile of/ })).not.toBeInTheDocument();
  });

  it('groups people by skill, summing their weeks', () => {
    setup({ groupBy: 'skill' });
    const list = within(sidebar());
    expect(list.getByText('Skill group')).toBeInTheDocument();
    expect(list.getByText('People')).toBeInTheDocument();
    expect(list.getByText('Backend')).toBeInTheDocument();
    expect(list.getByText('2 people')).toBeInTheDocument();
    expect(list.getByText('QA')).toBeInTheDocument();
    expect(list.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByLabelText('85% booked, 34 h')).toHaveTextContent('85%');
  });

  it('says so when nobody matches the filters', () => {
    setup({ load: loadOf([]) });
    expect(screen.getByText('No people match these filters.')).toBeInTheDocument();
  });

  it('explains the colours in a legend', () => {
    setup();
    const legend = within(screen.getByRole('list'));
    expect(legend.getByText('% of contract hours')).toBeInTheDocument();
    for (const label of ['Nothing booked', 'Under 50%', '50–79%', '80–100%', '101–120%', 'Over 120%', 'Includes tentative booking']) {
      expect(legend.getByText(label)).toBeInTheDocument();
    }
  });
});

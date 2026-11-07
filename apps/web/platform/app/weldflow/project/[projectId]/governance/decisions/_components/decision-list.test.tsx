import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';
import type { Decision } from '@weldsuite/app-api-client/domains/project-governance';

// The list needs the translations, the delete mutation and today's date; the rest of the app is not under test.
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: en,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
  }),
}));

const deleteDecision = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/queries/use-project-governance-queries', () => ({
  useDeleteDecision: () => ({ mutateAsync: deleteDecision, isPending: false }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../raid/_components/raid-context', () => ({
  useToday: () => new Date('2026-11-05T12:00:00.000Z'),
}));

import type { GovernanceAbilities, GovernanceMember } from '../../_lib/use-governance';
import { DecisionList } from './decision-list';

let counter = 0;

function decision(overrides: Partial<Decision> = {}): Decision {
  counter += 1;
  return {
    id: `dec_${counter}`,
    projectId: 'prj_1',
    number: counter,
    code: `DEC-${counter}`,
    title: `Decision ${counter}`,
    status: 'proposed',
    context: null,
    options: [],
    consequences: [],
    deciderId: null,
    decidedBy: null,
    decidedAt: null,
    decisionDueAt: null,
    supersededById: null,
    createdBy: 'user_a',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const taken = decision({
  code: 'DEC-10',
  title: 'Keep the legacy shop read-only',
  status: 'decided',
  decidedBy: 'user_a',
  decidedAt: '2026-10-20T00:00:00.000Z',
  options: [
    { title: 'Read-only for 90 days', note: null, chosen: true },
    { title: 'Switch it off', note: null, chosen: false },
  ],
});
const waiting = decision({
  code: 'DEC-11',
  title: 'Pick a payment provider',
  status: 'proposed',
  deciderId: 'user_a',
  decisionDueAt: '2026-11-01T00:00:00.000Z',
  options: [
    { title: 'Provider A', note: null, chosen: false },
    { title: 'Provider B', note: null, chosen: false },
  ],
});

const ALL: GovernanceAbilities = { create: true, update: true, remove: true, manage: true };
const NONE: GovernanceAbilities = { create: false, update: false, remove: false, manage: false };
const anna: GovernanceMember = { userId: 'user_a', name: 'Anna Jansen', avatar: null };

function setup(overrides: Partial<Parameters<typeof DecisionList>[0]> = {}) {
  const props = {
    decisions: [taken, waiting],
    search: '',
    onSearchChange: vi.fn(),
    filters: [],
    onFiltersChange: vi.fn(),
    abilities: ALL,
    memberOf: (id: string | null | undefined) => (id === 'user_a' ? anna : null),
    selectedId: null,
    onSelect: vi.fn(),
    onDialog: vi.fn(),
    ...overrides,
  };
  render(<DecisionList {...props} />);
  return props;
}

async function openMenu(row: string) {
  const user = userEvent.setup();
  const target = screen.getByRole('button', { name: row });
  const menu = target.parentElement?.querySelector('button[aria-label="More actions"]');
  if (!menu) throw new Error(`The row "${row}" has no menu`);
  await user.click(menu);
  return user;
}

describe('DecisionList', () => {
  it('lists a row per decision with its code, title, decider, date, option and status', () => {
    setup();
    expect(screen.getByRole('button', { name: 'DEC-10 Keep the legacy shop read-only' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DEC-11 Pick a payment provider' })).toBeInTheDocument();
    // The decider is shown by first name, once for each row.
    expect(screen.getAllByText('Anna')).toHaveLength(2);
    expect(screen.getByText('Decided')).toBeInTheDocument();
    expect(screen.getByText('Proposed')).toBeInTheDocument();
    expect(screen.getByText('Read-only for 90 days')).toBeInTheDocument();
    expect(screen.getByText('2 options')).toBeInTheDocument();
  });

  it('shows the decided date, and the due date of a proposed decision in red once it is past', () => {
    setup();
    expect(screen.getByText('Oct 20, 2026')).toBeInTheDocument();
    expect(screen.getByText('Due Nov 1, 2026')).toHaveClass('text-red-700');
  });

  it('opens the decision when its row is clicked, and marks the open one', async () => {
    const props = setup({ selectedId: waiting.id });
    await userEvent.click(screen.getByRole('button', { name: 'DEC-10 Keep the legacy shop read-only' }));
    expect(props.onSelect).toHaveBeenCalledWith(taken.id);
    expect(screen.getByRole('button', { name: 'DEC-11 Pick a payment provider' }).parentElement).toHaveAttribute('aria-current', 'true');
  });

  it('offers record, edit and delete on a proposed decision', async () => {
    const props = setup();
    const user = await openMenu('DEC-11 Pick a payment provider');
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Record decision' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Replace with another decision' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Record decision' }));
    expect(props.onDialog).toHaveBeenCalledWith({ kind: 'decide', decision: waiting });
  });

  it('offers replace instead of record on a decided decision', async () => {
    const props = setup();
    const user = await openMenu('DEC-10 Keep the legacy shop read-only');
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Record decision' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Replace with another decision' }));
    expect(props.onDialog).toHaveBeenCalledWith({ kind: 'supersede', decision: taken });
  });

  it('keeps replace to the project manager', async () => {
    setup({ abilities: { ...ALL, manage: false } });
    await openMenu('DEC-10 Keep the legacy shop read-only');
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Replace with another decision' })).not.toBeInTheDocument();
  });

  it('asks before it deletes a decision, then deletes it', async () => {
    setup();
    const user = await openMenu('DEC-11 Pick a payment provider');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByText('Delete DEC-11?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteDecision).toHaveBeenCalledWith(waiting.id));
  });

  it('closes the panel of a decision it deletes', async () => {
    const props = setup({ selectedId: waiting.id });
    const user = await openMenu('DEC-11 Pick a payment provider');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(null));
  });

  it('has no row menu for a member who may not change anything', () => {
    setup({ abilities: NONE });
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('shows the illustrated empty state with a way to start the log', async () => {
    const props = setup({ decisions: [] });
    expect(screen.getByText('No decisions yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New decision' }));
    expect(props.onDialog).toHaveBeenCalledWith({ kind: 'create' });
  });

  it('shows the empty state of a read-only member without the create button', () => {
    setup({ decisions: [], abilities: NONE });
    expect(screen.getByText('No decisions have been recorded for this project.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New decision' })).not.toBeInTheDocument();
  });

  it('says nothing matches when a search leaves no decision', () => {
    setup({ decisions: [], search: 'zzz' });
    expect(screen.getByText('No decision matches your filters.')).toBeInTheDocument();
  });
});

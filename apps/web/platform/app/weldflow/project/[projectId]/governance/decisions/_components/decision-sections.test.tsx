import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { Decision, DecisionDetail } from '@weldsuite/app-api-client/domains/project-governance';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate }),
}));

const open = vi.fn();
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open }),
}));

// Only tasks and RAID items have an object panel here; milestones do not.
vi.mock('@/components/object-panel/object-panel-registry', () => ({
  resolveObjectPanel: (type: string) => (type === 'task' || type === 'raid_item' ? { type } : undefined),
}));

import { LinkedList, OptionsList, ProposedBanner } from './decision-sections';

function link(id: string, type: DecisionDetail['links'][number]['target']['type'], title: string, code: string | null = null): DecisionDetail['links'][number] {
  return {
    id,
    projectId: 'prj_1',
    fromType: 'decision',
    fromId: 'dec_1',
    toType: type,
    toId: `${type}_1`,
    relation: 'affects',
    createdBy: 'user_a',
    createdAt: '2026-11-01T00:00:00.000Z',
    direction: 'outgoing',
    target: { type, id: `${type}_1`, projectId: 'prj_1', title, status: 'open', code, ownerId: null, dueDate: null },
  } as DecisionDetail['links'][number];
}

describe('LinkedList', () => {
  it('opens a task or a RAID item on top of the panel', async () => {
    render(<LinkedList links={[link('l1', 'task', 'Draft the contract'), link('l2', 'raid_item', 'Vendor lock-in', 'RSK-4')]} />);
    expect(screen.getByText('RSK-4')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Draft the contract/ }));
    expect(open).toHaveBeenCalledWith({ type: 'task', id: 'task_1', stack: true });
    await userEvent.click(screen.getByRole('button', { name: /Vendor lock-in/ }));
    expect(open).toHaveBeenCalledWith({ type: 'raid_item', id: 'raid_item_1', stack: true });
  });

  it('lists a record without an object panel as plain text', () => {
    render(<LinkedList links={[link('l3', 'milestone', 'Go-live')]} />);
    expect(screen.getByText('Go-live')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go-live/ })).not.toBeInTheDocument();
  });
});

describe('OptionsList', () => {
  it('numbers the options and marks the one taken', () => {
    const options: Decision['options'] = [
      { title: 'Build it', note: 'Slow, ours', chosen: false },
      { title: 'Buy it', note: null, chosen: true },
    ];
    render(<OptionsList options={options} />);
    expect(screen.getByText('Build it')).toBeInTheDocument();
    expect(screen.getByText('Slow, ours')).toBeInTheDocument();
    expect(screen.getByText(/Buy it/)).toHaveTextContent('chosen');
    expect(screen.getByText('Build it').closest('li')).not.toHaveTextContent('chosen');
  });

  it('says so when no option was recorded', () => {
    render(<OptionsList options={[]} />);
    expect(screen.getByText('No options were recorded.')).toBeInTheDocument();
  });
});

describe('ProposedBanner', () => {
  const row = { deciderId: 'user_a', decisionDueAt: null } as Decision;
  const memberName = (id: string | null | undefined) => (id === 'user_a' ? 'Anna Jansen' : 'Unassigned');

  it('names who has to decide and offers to record it when the member may', async () => {
    const onDecide = vi.fn();
    render(<ProposedBanner row={row} declined={undefined} canRecord onDecide={onDecide} memberName={memberName} />);
    expect(screen.getByText('Waiting for Anna Jansen to decide.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('has no button for a member who may not record, and shows who declined', () => {
    const declined = { id: 'a1', approverId: 'user_a', decision: 'rejected', note: 'Too costly', dueAt: null, decidedAt: null, delegatedFrom: null };
    render(<ProposedBanner row={row} declined={declined} canRecord={false} onDecide={vi.fn()} memberName={memberName} />);
    expect(screen.queryByRole('button', { name: 'Record decision' })).not.toBeInTheDocument();
    expect(screen.getByText('Anna Jansen declined: Too costly')).toBeInTheDocument();
  });
});

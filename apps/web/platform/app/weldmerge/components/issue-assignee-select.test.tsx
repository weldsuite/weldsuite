import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssueAssigneeSelect } from './issue-assignee-select';

const state = vi.hoisted(() => ({
  agents: [] as Array<{ id: string; name: string }>,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@/hooks/queries/use-agent-queries', () => ({ useAgents: () => ({ data: state.agents }) }));
vi.mock('../lib/use-members', () => ({
  useMergeMembers: () => ({ members: [{ userId: 'user_1', name: 'Sanne', picture: null }], memberById: new Map(), currentUserId: 'user_1' }),
}));

beforeEach(() => {
  state.agents = [{ id: 'agt_1', name: 'Triage bot' }];
});

describe('IssueAssigneeSelect', () => {
  it('shows a member assignee', () => {
    render(<IssueAssigneeSelect issue={{ assigneeUserId: 'user_1', agentId: null }} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox').textContent).toContain('Sanne');
  });

  it('shows an agent assignee and explains what that means', () => {
    render(<IssueAssigneeSelect issue={{ assigneeUserId: null, agentId: 'agt_1' }} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox').textContent).toContain('Triage bot');
    expect(screen.getByText('An agent assigned here picks the issue up as its task.')).toBeTruthy();
  });

  it('shows Unassigned when nobody is', () => {
    render(<IssueAssigneeSelect issue={{ assigneeUserId: null, agentId: null }} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox').textContent).toContain('Unassigned');
  });

  it('can be disabled', () => {
    render(<IssueAssigneeSelect issue={{ assigneeUserId: null, agentId: null }} disabled onChange={vi.fn()} />);
    expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true);
  });
});

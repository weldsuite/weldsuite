import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { MergeCommentForm, MergeCreateIssueForm, MergeUpdateIssueForm } from './merge-action-forms';

const state = vi.hoisted(() => ({
  teams: { isSuccess: true, data: [{ id: 'mtm_1', name: 'Platform', key: 'PLAT' }] as unknown[] },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({ useMergeTeams: () => state.teams }));
// The variable picker is its own component; a plain input stands in for it here.
vi.mock('./localized-variable-input', () => ({
  VariableInput: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const tc = en.weldmerge.across.connect;

beforeEach(() => {
  state.teams = { isSuccess: true, data: [{ id: 'mtm_1', name: 'Platform', key: 'PLAT' }] };
});

describe('MergeCreateIssueForm', () => {
  it('writes the title, description and assignee into the step config', () => {
    const onChange = vi.fn();
    render(<MergeCreateIssueForm config={{ teamId: 'mtm_1' }} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(tc.issueTitlePlaceholder), { target: { value: 'Fix {{trigger.record.title}}' } });
    expect(onChange).toHaveBeenCalledWith({ teamId: 'mtm_1', title: 'Fix {{trigger.record.title}}' });
    fireEvent.change(screen.getByPlaceholderText(tc.issueDescriptionPlaceholder), { target: { value: 'Details' } });
    expect(onChange).toHaveBeenLastCalledWith({ teamId: 'mtm_1', description: 'Details' });
    fireEvent.change(screen.getByPlaceholderText(tc.assigneePlaceholder), { target: { value: 'user_1' } });
    expect(onChange).toHaveBeenLastCalledWith({ teamId: 'mtm_1', assigneeUserId: 'user_1' });
  });

  it('says when there are no teams yet', () => {
    state.teams = { isSuccess: true, data: [] };
    render(<MergeCreateIssueForm config={{}} onChange={vi.fn()} />);
    expect(screen.getByText(tc.noTeams)).toBeTruthy();
  });

  it('mentions that the step runs as the workflow owner', () => {
    render(<MergeCreateIssueForm config={{}} onChange={vi.fn()} />);
    expect(screen.getByText(tc.variablesHint)).toBeTruthy();
  });
});

describe('MergeUpdateIssueForm', () => {
  it('takes the issue key and optional changes', () => {
    const onChange = vi.fn();
    render(<MergeUpdateIssueForm config={{ status: 'done' }} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(tc.issuePlaceholder), { target: { value: 'PLAT-209' } });
    expect(onChange).toHaveBeenCalledWith({ status: 'done', issue: 'PLAT-209' });
    fireEvent.change(screen.getByPlaceholderText(tc.issueTitlePlaceholder), { target: { value: 'New title' } });
    expect(onChange).toHaveBeenLastCalledWith({ status: 'done', title: 'New title' });
  });
});

describe('MergeCommentForm', () => {
  it('takes the issue and the comment text', () => {
    const onChange = vi.fn();
    render(<MergeCommentForm config={{ issue: 'PLAT-209' }} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(tc.commentPlaceholder), { target: { value: 'Shipped in {{trigger.record.name}}' } });
    expect(onChange).toHaveBeenCalledWith({ issue: 'PLAT-209', body: 'Shipped in {{trigger.record.name}}' });
  });
});

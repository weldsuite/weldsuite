import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { MergeRecordLinkDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { IssueCustomersPanel } from './issue-customers-panel';
import { IssueLinksPanel } from './issue-links-panel';
import { IssueTimePanel } from './issue-time-panel';

const state = vi.hoisted(() => ({
  can: {} as Record<string, boolean>,
  openPanel: vi.fn(),
  createLink: vi.fn(),
  removeLink: vi.fn(),
  time: { isError: false, data: [] as unknown[] },
  logTime: vi.fn(),
  ticketRows: {} as Record<string, unknown>,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.can[key] === true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: state.openPanel }) }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({ get: async (url: string) => ({ data: state.ticketRows[url.replace('/tickets/', '')] ?? {} }) }),
  }),
}));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({ weldmergeKeys: { all: ['weldmerge'] } }));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  useCreateMergeIssueLink: () => ({ mutateAsync: state.createLink, isPending: false }),
  useRemoveMergeIssueLink: () => ({ mutate: state.removeLink, isPending: false }),
  useMergeIssueTime: () => state.time,
  useLogMergeIssueTime: () => ({ mutateAsync: state.logTime, isPending: false }),
  sumMinutes: (entries: Array<{ duration: string | number }>) => entries.reduce((sum, e) => sum + Number(e.duration), 0),
}));

// The customers panel reads tickets through react-query.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const withQuery = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

const link = (over: Partial<MergeRecordLinkDto>): MergeRecordLinkDto => ({
  id: 'mrl_1',
  issueId: 'mis_1',
  recordType: 'desk_ticket',
  recordId: 'tkt_1',
  title: 'Cannot log in',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  state.can = { 'time:create': true };
  state.openPanel = vi.fn();
  state.createLink = vi.fn().mockResolvedValue({});
  state.removeLink = vi.fn();
  state.time = { isError: false, data: [] };
  state.logTime = vi.fn().mockResolvedValue({});
  state.ticketRows = {};
});

describe('IssueLinksPanel', () => {
  it('lists links and opens the record in its panel', () => {
    render(<IssueLinksPanel issue={{ id: 'mis_1', recordLinks: [link({}), link({ id: 'mrl_2', recordType: 'crm_company', recordId: 'cus_1', title: 'Acme' })] }} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }));
    expect(state.openPanel).toHaveBeenCalledWith({ type: 'company', id: 'cus_1' });
    fireEvent.click(screen.getByRole('button', { name: /Cannot log in/ }));
    expect(state.openPanel).toHaveBeenCalledWith({ type: 'ticket', id: 'tkt_1' });
  });

  it('says when nothing is linked', () => {
    render(<IssueLinksPanel issue={{ id: 'mis_1', recordLinks: [] }} canEdit />);
    expect(screen.getByText(en.weldmerge.across.issue.links.empty)).toBeTruthy();
  });

  it('removes a link', () => {
    render(<IssueLinksPanel issue={{ id: 'mis_1', recordLinks: [link({})] }} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.issue.links.remove }));
    expect(state.removeLink).toHaveBeenCalledWith('mrl_1', expect.any(Object));
  });

  it('links another record by id', async () => {
    render(<IssueLinksPanel issue={{ id: 'mis_1', recordLinks: [] }} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.issue.links.add) }));
    fireEvent.change(screen.getByLabelText(en.weldmerge.across.issue.links.recordId), { target: { value: ' tkt_9 ' } });
    fireEvent.change(screen.getByLabelText(en.weldmerge.across.issue.links.titleLabel), { target: { value: 'Slow export' } });
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.issue.links.submit }));
    await waitFor(() => expect(state.createLink).toHaveBeenCalled());
    expect(state.createLink).toHaveBeenCalledWith({ recordType: 'desk_ticket', recordId: 'tkt_9', title: 'Slow export' });
  });

  it('is read-only without update permission', () => {
    render(<IssueLinksPanel issue={{ id: 'mis_1', recordLinks: [link({})] }} canEdit={false} />);
    expect(screen.queryByRole('button', { name: en.weldmerge.across.issue.links.remove })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(en.weldmerge.across.issue.links.add) })).toBeNull();
  });
});

describe('IssueCustomersPanel', () => {
  it('lists the company linked directly and the one a ticket belongs to', async () => {
    state.ticketRows = { tkt_1: { counterpartyId: 'cus_2', customerCompany: 'Globex' } };
    render(
      withQuery(
        <IssueCustomersPanel
          issue={{ recordLinks: [link({ id: 'a', recordType: 'crm_company', recordId: 'cus_1', title: 'Acme' }), link({})] }}
        />,
      ),
    );
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(await screen.findByText('Globex')).toBeTruthy();
    expect(screen.getByText('Through Cannot log in')).toBeTruthy();
    fireEvent.click(screen.getByText('Globex'));
    expect(state.openPanel).toHaveBeenCalledWith({ type: 'company', id: 'cus_2' });
  });

  it('says when there are no customers', () => {
    render(withQuery(<IssueCustomersPanel issue={{ recordLinks: [] }} />));
    expect(screen.getByText(en.weldmerge.across.issue.customers.empty)).toBeTruthy();
  });
});

describe('IssueTimePanel', () => {
  it('totals the logged time', () => {
    state.time.data = [
      { id: 'a', date: '2026-11-01', duration: '90', description: 'Debugging' },
      { id: 'b', date: '2026-11-02', duration: 30, description: '' },
    ];
    render(<IssueTimePanel issueId="mis_1" />);
    expect(screen.getByText('2h logged')).toBeTruthy();
    expect(screen.getByText('Debugging')).toBeTruthy();
  });

  it('logs hours as minutes', async () => {
    render(<IssueTimePanel issueId="mis_1" />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.issue.time.log) }));
    fireEvent.change(screen.getByLabelText(en.weldmerge.across.issue.time.hours), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText(en.weldmerge.across.issue.time.description), { target: { value: ' Pairing ' } });
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.issue.time.submit }));
    await waitFor(() => expect(state.logTime).toHaveBeenCalled());
    expect(state.logTime).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'mis_1', minutes: 90, description: 'Pairing' }));
  });

  it('refuses a zero duration', () => {
    render(<IssueTimePanel issueId="mis_1" />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.issue.time.log) }));
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.issue.time.submit }));
    expect(state.logTime).not.toHaveBeenCalled();
  });

  it('does not offer logging without time:create', () => {
    state.can = {};
    render(<IssueTimePanel issueId="mis_1" />);
    expect(screen.queryByRole('button', { name: new RegExp(en.weldmerge.across.issue.time.log) })).toBeNull();
    expect(screen.getByText(en.weldmerge.across.issue.time.none)).toBeTruthy();
  });
});

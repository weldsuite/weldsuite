import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { buildEscalationLinks, TicketWeldMergeSection, useWeldMergeTicketAccess } from './ticket-weldmerge-section';

const state = vi.hoisted(() => ({
  can: { 'merge_issues:read': true, 'merge_issues:create': true } as Record<string, boolean>,
  installed: true,
  appLoading: false,
  links: { isLoading: false, isError: false, data: [] as unknown[] },
  teams: { isSuccess: true, data: [{ id: 'mtm_1', name: 'Platform', key: 'PLAT' }] as unknown[] },
  ticket: { data: { data: { counterpartyId: 'cus_1', customerCompany: 'Acme' } } },
  escalate: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.can[key] === true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: state.installed, isLoading: state.appLoading }) }));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  useMergeRecordLinks: () => state.links,
  useEscalateToMergeIssue: () => ({ mutateAsync: state.escalate, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({ useMergeTeams: () => state.teams }));
vi.mock('@/hooks/queries/use-helpdesk-queries', () => ({ useTicket: () => state.ticket }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const linked = {
  link: { id: 'mrl_1', issueId: 'mis_1', recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Cannot log in', createdAt: '2026-11-01T00:00:00.000Z' },
  issue: { id: 'mis_1', key: 'PLAT-209', title: 'Login is slow', status: 'in_progress', teamId: 'mtm_1', teamKey: 'PLAT' },
  release: { id: 'mrl_1', name: 'Spring release', version: 'v1.4.0', shippedAt: '2026-11-05T09:00:00.000Z' },
};

beforeEach(() => {
  state.can = { 'merge_issues:read': true, 'merge_issues:create': true };
  state.installed = true;
  state.appLoading = false;
  state.links = { isLoading: false, isError: false, data: [] };
  state.teams = { isSuccess: true, data: [{ id: 'mtm_1', name: 'Platform', key: 'PLAT' }] };
  state.escalate = vi.fn().mockResolvedValue({ key: 'PLAT-300' });
});

describe('useWeldMergeTicketAccess', () => {
  it('needs the app installed and merge_issues:read', () => {
    expect(renderHook(() => useWeldMergeTicketAccess()).result.current).toBe(true);
    state.installed = false;
    expect(renderHook(() => useWeldMergeTicketAccess()).result.current).toBe(false);
    state.installed = true;
    state.can['merge_issues:read'] = false;
    expect(renderHook(() => useWeldMergeTicketAccess()).result.current).toBe(false);
  });

  it('stays off while the installed apps load', () => {
    state.appLoading = true;
    expect(renderHook(() => useWeldMergeTicketAccess()).result.current).toBe(false);
  });
});

describe('buildEscalationLinks', () => {
  it('links the ticket and its company', () => {
    expect(buildEscalationLinks({ id: 'tkt_1', subject: 'Login broken' }, { id: 'cus_1', name: 'Acme' })).toEqual([
      { recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Login broken' },
      { recordType: 'crm_company', recordId: 'cus_1', title: 'Acme' },
    ]);
  });

  it('links only the ticket when it has no company', () => {
    expect(buildEscalationLinks({ id: 'tkt_1', subject: 'Login broken' }, { id: null, name: null })).toEqual([
      { recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Login broken' },
    ]);
  });
});

describe('TicketWeldMergeSection', () => {
  it('lists linked issues with status and the release that shipped them', () => {
    state.links.data = [linked];
    render(<TicketWeldMergeSection ticketId="tkt_1" subject="Cannot log in" description="Body" />);
    const link = screen.getByRole('link', { name: /PLAT-209/ });
    expect(link.getAttribute('href')).toBe('/weldmerge/issues/PLAT-209');
    expect(screen.getByText('Shipped in Spring release v1.4.0')).toBeTruthy();
  });

  it('says when nothing is linked', () => {
    render(<TicketWeldMergeSection ticketId="tkt_1" subject="Cannot log in" description="Body" />);
    expect(screen.getByText(en.weldmerge.across.desk.empty)).toBeTruthy();
  });

  it('escalates with the ticket text prefilled and both links', async () => {
    render(<TicketWeldMergeSection ticketId="tkt_1" subject="Cannot log in" description="Steps to reproduce" />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.desk.escalate) }));
    expect((screen.getByLabelText(en.weldmerge.across.desk.issueTitle) as HTMLInputElement).value).toBe('Cannot log in');
    expect((screen.getByLabelText(en.weldmerge.across.desk.issueDescription) as HTMLTextAreaElement).value).toBe('Steps to reproduce');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.desk.create) }));
    await waitFor(() => expect(state.escalate).toHaveBeenCalled());
    expect(state.escalate).toHaveBeenCalledWith({
      teamId: 'mtm_1',
      title: 'Cannot log in',
      description: 'Steps to reproduce',
      links: [
        { recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Cannot log in' },
        { recordType: 'crm_company', recordId: 'cus_1', title: 'Acme' },
      ],
    });
  });

  it('does not offer escalation without merge_issues:create', () => {
    state.can['merge_issues:create'] = false;
    render(<TicketWeldMergeSection ticketId="tkt_1" subject="Cannot log in" description="" />);
    expect(screen.queryByRole('button', { name: new RegExp(en.weldmerge.across.desk.escalate) })).toBeNull();
  });

  it('shows a load failure', () => {
    state.links = { isLoading: false, isError: true, data: [] };
    render(<TicketWeldMergeSection ticketId="tkt_1" subject="x" description="" />);
    expect(screen.getByText(en.weldmerge.across.desk.loadFailed)).toBeTruthy();
  });
});

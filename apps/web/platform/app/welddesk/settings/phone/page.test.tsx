import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DeskPhoneRoute } from '@/hooks/queries/use-desk-phone-settings-queries';
import PhoneSettingsPage from './page';

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const route = (patch: Partial<DeskPhoneRoute>): DeskPhoneRoute => ({
  id: 'dpr',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  voipPhoneNumberId: 'vpn_1',
  action: 'hangup',
  voiceAgentId: null,
  forwardToE164: null,
  schedule: null,
  options: null,
  ...patch,
});

const routes: DeskPhoneRoute[] = [
  route({ voipPhoneNumberId: 'vpn_1', action: 'agents', options: { departmentId: 'dept_support', maxWaitSeconds: 300, whenUnanswered: 'voicemail' } }),
  route({
    voipPhoneNumberId: 'vpn_2',
    action: 'menu',
    options: {
      menu: {
        prompt: 'p',
        choices: [
          { digit: '1', label: 'Sales', action: 'agents' },
          { digit: '2', label: 'Support', action: 'agents' },
          { digit: '0', action: 'voicemail' },
        ],
      },
    },
  }),
];

vi.mock('@/hooks/queries/use-desk-phone-settings-queries', () => ({
  useDeskPhoneNumbers: () => ({
    data: [
      { id: 'vpn_1', phoneNumber: '+31201234567', displayName: 'Main line', status: 'active' },
      { id: 'vpn_2', phoneNumber: '+31207654321', displayName: null, status: 'active' },
      { id: 'vpn_3', phoneNumber: '+31209999999', displayName: null, status: 'active' },
      { id: 'vpn_4', phoneNumber: '+31208888888', displayName: null, status: 'active', sipTrunkId: 'strk_1' },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDeskPhoneRoutes: () => ({ data: routes, isLoading: false, isError: false, refetch: vi.fn() }),
  useDeskPhoneVoiceAgents: () => ({ data: [] }),
  useSyncDeskPhoneNumbers: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveDeskPhoneRoute: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The own-phone-system section has its own tests (sip-trunks/).
vi.mock('./sip-trunks/sip-trunks-section', () => ({ SipTrunksSection: () => <div data-testid="sip-trunks-section" /> }));
vi.mock('@/hooks/queries/use-desk-sip-trunk-queries', () => ({
  useDeskSipTrunks: () => ({ data: [{ id: 'strk_1', name: 'Head office Xelion' }] }),
}));

vi.mock('@/hooks/queries/use-desk-routing-queries', () => ({
  useDeskTeams: () => ({
    data: [{ id: 'dept_support', name: 'Support', isActive: true, agentIds: [], escalationRules: [], sortOrder: 0 }],
  }),
}));

describe('PhoneSettingsPage', () => {
  it('reads each number route in a line', () => {
    render(<PhoneSettingsPage />);
    const summaries = screen.getAllByTestId('phone-route-summary').map((el) => el.textContent);
    expect(summaries).toEqual([
      'Rings Support, then voicemail after 5 min',
      'Menu: 1 Sales, 2 Support, 0 Voicemail',
      'No route set: calls are hung up',
      'No route set: calls are hung up',
    ]);
  });

  it('labels a number on the customer own phone system with its trunk, and shows the section', () => {
    render(<PhoneSettingsPage />);
    const badges = screen.getAllByTestId('phone-number-trunk');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Via Head office Xelion');
    expect(screen.getByTestId('sip-trunks-section')).toBeInTheDocument();
  });

  it('explains how ringing works and where agents switch on take calls', () => {
    render(<PhoneSettingsPage />);
    const help = screen.getByTestId('phone-ring-help');
    expect(help).toHaveTextContent('ringing tone');
    expect(help).toHaveTextContent('Take calls');
    expect(help).toHaveTextContent('inbox');
    expect(help).toHaveTextContent('synthetic voice');
  });
});

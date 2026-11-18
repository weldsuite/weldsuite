import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import MailLabelsSettingsPage from './page';

let accounts: { data?: { id: string; isDefault?: boolean }[]; isLoading: boolean };
let labels: { data?: Record<string, unknown>[]; isLoading: boolean };
const useMailLabels = vi.fn();
const labelsClient = vi.fn();

vi.mock('@/hooks/queries/use-mail-queries', () => ({
  useMailAccounts: () => ({ data: accounts.data && { data: accounts.data }, isLoading: accounts.isLoading }),
  useMailLabels: (...args: unknown[]) => {
    useMailLabels(...args);
    return { data: labels.data && { data: labels.data }, isLoading: labels.isLoading };
  },
}));
vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en }) }));
vi.mock('@weldsuite/ui/components/page-loader', () => ({
  PageLoader: () => <div data-testid="page-loader" />,
}));
vi.mock('./labels-client', () => ({
  LabelsClient: (props: { initialLabels: { name: string }[]; accountId: string }) => {
    labelsClient(props);
    return (
      <ul>
        {props.initialLabels.map((l) => (
          <li key={l.name}>{l.name}</li>
        ))}
      </ul>
    );
  },
}));

const L = en.mail.settingsLabels;

describe('MailLabelsSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accounts = { data: [{ id: 'a1' }, { id: 'a2', isDefault: true }], isLoading: false };
    labels = { data: [], isLoading: false };
  });

  it('shows a loader while accounts load', () => {
    accounts = { data: undefined, isLoading: true };
    render(<MailLabelsSettingsPage />);
    expect(screen.getByTestId('page-loader')).toBeTruthy();
  });

  it('shows a loader while labels load', () => {
    labels = { data: undefined, isLoading: true };
    render(<MailLabelsSettingsPage />);
    expect(screen.getByTestId('page-loader')).toBeTruthy();
  });

  it('shows the no-account state and does not enable the labels query', () => {
    accounts = { data: [], isLoading: false };
    render(<MailLabelsSettingsPage />);
    expect(screen.getByText(L.noEmailAccountFound)).toBeTruthy();
    expect(screen.getByText(L.labelManagementDescription)).toBeTruthy();
    expect(useMailLabels).toHaveBeenCalledWith(undefined, false);
    expect(labelsClient).not.toHaveBeenCalled();
  });

  it('handles missing account data', () => {
    accounts = { data: undefined, isLoading: false };
    render(<MailLabelsSettingsPage />);
    expect(screen.getByText(L.noEmailAccountFound)).toBeTruthy();
  });

  it('uses the default account and hides system labels', () => {
    labels = {
      data: [
        { id: 'l1', name: 'Clients', color: '#fff', messageCount: 4, aiEnabled: true, aiKeywords: ['k'], aiDescription: 'd', aiConfidence: 60 },
        { id: 'l2', name: 'Custom system', isSystem: true },
        { id: 'l3', name: 'Inbox' },
        { id: 'l4', name: 'Bare', color: null, messageCount: null, aiEnabled: null, aiKeywords: null, aiConfidence: null },
      ],
      isLoading: false,
    };
    render(<MailLabelsSettingsPage />);

    expect(useMailLabels).toHaveBeenCalledWith('a2', true);
    expect(screen.getByText(L.labelManagementDescription)).toBeTruthy();
    expect(screen.getByText('Clients')).toBeTruthy();
    expect(screen.queryByText('Custom system')).toBeNull();
    expect(screen.queryByText('Inbox')).toBeNull();

    const props = labelsClient.mock.calls[0][0];
    expect(props.accountId).toBe('a2');
    expect(props.initialLabels).toEqual([
      { id: 'l1', name: 'Clients', color: '#fff', count: 4, aiEnabled: true, aiKeywords: ['k'], aiDescription: 'd', aiConfidence: 60 },
      { id: 'l4', name: 'Bare', color: undefined, count: 0, aiEnabled: undefined, aiKeywords: undefined, aiDescription: undefined, aiConfidence: undefined },
    ]);
  });

  it('falls back to the first account and an empty list', () => {
    accounts = { data: [{ id: 'first' }], isLoading: false };
    labels = { data: undefined, isLoading: false };
    render(<MailLabelsSettingsPage />);
    expect(labelsClient.mock.calls[0][0]).toMatchObject({ accountId: 'first', initialLabels: [] });
  });
});

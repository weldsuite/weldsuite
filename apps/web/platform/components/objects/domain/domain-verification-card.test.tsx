import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { DomainVerificationCard } from './domain-verification-card';

const mutateAsync = vi.fn();
const push = vi.fn();
const toastError = vi.fn();
let canVerify = true;

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  useCan: () => canVerify,
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}));

vi.mock('@/hooks/queries/use-host-queries', () => ({
  useVerifyDomainOwnership: () => ({ mutateAsync, isPending: false }),
}));

const td = en.host.domainDetail;
const record = {
  name: '_weldhost-verify.pending.com',
  type: 'TXT' as const,
  value: 'weldhost-verify=abc',
};

function renderCard() {
  render(<DomainVerificationCard domainId="dom_pending" domainName="pending.com" record={record} />);
}

describe('DomainVerificationCard', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    push.mockReset();
    toastError.mockReset();
    canVerify = true;
  });

  it('shows the TXT record to add', () => {
    renderCard();

    expect(screen.getByText(td.pendingVerificationTitle.replace('{domain}', 'pending.com'))).toBeInTheDocument();
    expect(screen.getByText(record.name)).toBeInTheDocument();
    expect(screen.getByText(record.value)).toBeInTheDocument();
  });

  it('resumes the wizard after a successful verify', async () => {
    mutateAsync.mockResolvedValue({ data: { nameservers: [] } });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: td.verifyOwnership }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/weldhost/domains/external?domain=dom_pending'));
    expect(mutateAsync).toHaveBeenCalledWith('dom_pending');
  });

  it('stays put and shows the API error when the record is not found yet', async () => {
    mutateAsync.mockRejectedValue(new Error('TXT record not found'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: td.verifyOwnership }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('TXT record not found'));
    expect(push).not.toHaveBeenCalled();
  });

  it('hides the verify button without permission to add domains', () => {
    canVerify = false;
    renderCard();

    expect(screen.queryByRole('button', { name: td.verifyOwnership })).toBeNull();
  });
});

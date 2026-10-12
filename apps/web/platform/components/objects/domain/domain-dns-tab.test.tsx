import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import { toast } from 'sonner';
import { DomainDnsTab } from './domain-dns-tab';
import type { HostDnsRecord } from '@/hooks/queries/use-host-queries';

const mutations = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/hooks/queries/use-host-queries', () => ({
  getDnsRecordLocks: (record: { metadata?: { locks?: unknown[] } | null }) => record.metadata?.locks ?? [],
  useCreateDnsRecord: () => ({ mutateAsync: mutations.create, isPending: false }),
  useUpdateDnsRecord: () => ({ mutateAsync: mutations.update, isPending: false }),
  useDeleteDnsRecord: () => ({ mutateAsync: mutations.remove, isPending: false }),
}));

const td = en.host.domainDetail;
const tw = en.host.weldReach;

function record(over: Partial<HostDnsRecord> & Pick<HostDnsRecord, 'id' | 'type' | 'name' | 'value'>): HostDnsRecord {
  return {
    zoneId: 'zone_1',
    externalRecordId: `cf_${over.id}`,
    ttl: 3600,
    priority: null,
    weight: null,
    port: null,
    caaFlag: null,
    caaTag: null,
    status: 'active',
    syncedAt: null,
    syncError: null,
    comment: null,
    metadata: null,
    ...over,
  };
}

const records: HostDnsRecord[] = [
  record({ id: 'r_mx', type: 'MX', name: 'getacme.com', value: 'mx.mailpool.io', priority: 10, managedBy: 'weldreach' }),
  record({ id: 'r_spf', type: 'TXT', name: 'getacme.com', value: 'v=spf1 -all', managedBy: 'weldreach' }),
  record({ id: 'r_www', type: 'A', name: 'www.getacme.com', value: '203.0.113.7', managedBy: null }),
  record({
    id: 'r_mail',
    type: 'TXT',
    name: '_mail.getacme.com',
    value: 'v=weldmail',
    metadata: { locks: [{ source: 'weldmail', reason: 'Required by WeldMail', lockedAt: '2026-10-01T00:00:00Z' }] },
  }),
];

function renderTab() {
  return render(
    <DomainDnsTab
      domainId="dom_1"
      records={records}
      isLoading={false}
      hasZone
      canCreate
      canEdit
      canDelete
    />,
  );
}

const rowButton = (label: string) => screen.getByRole('button', { name: label });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DomainDnsTab: records WeldReach manages', () => {
  it('badges them with a "Managed by WeldReach" tooltip, and nothing else', () => {
    renderTab();

    const badges = screen.getAllByTestId('weldreach-managed-badge');
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge).toHaveTextContent(tw.recordBadge);
      expect(badge).toHaveAttribute('title', tw.recordManaged);
    }
  });

  it('disables edit and delete on them, with the reason', () => {
    renderTab();

    const edit = (type: string, name: string) =>
      rowButton(td.editRecordAriaLabel.replace('{type}', type).replace('{name}', name));
    const remove = (type: string, name: string) =>
      rowButton(td.deleteRecordAriaLabel.replace('{type}', type).replace('{name}', name));

    for (const button of [edit('MX', 'getacme.com'), remove('MX', 'getacme.com'), edit('TXT', 'getacme.com')]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', tw.recordManagedHint);
    }
  });

  it('leaves the other records editable, and keeps the existing lock badge for WeldMail', () => {
    renderTab();

    const editWww = rowButton(td.editRecordAriaLabel.replace('{type}', 'A').replace('{name}', 'www.getacme.com'));
    expect(editWww).toBeEnabled();

    const editMail = rowButton(td.editRecordAriaLabel.replace('{type}', 'TXT').replace('{name}', '_mail.getacme.com'));
    expect(editMail).toBeDisabled();
    expect(screen.getByText(td.usedByEmail)).toBeInTheDocument();
  });
});

describe('DomainDnsTab: 409 from host-api', () => {
  it('shows a managed-record 409 in the reader\'s language, not the server text', async () => {
    mutations.remove.mockRejectedValue(
      new ApiError('server text', 409, { error: { code: 'DNS_RECORD_MANAGED_BY_WELDREACH', message: 'server text' } }),
    );
    renderTab();

    fireEvent.click(rowButton(td.deleteRecordAriaLabel.replace('{type}', 'A').replace('{name}', 'www.getacme.com')));
    fireEvent.click(await screen.findByRole('button', { name: td.deleteAction }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(tw.recordManagedError));
  });

  it('keeps the server message for any other failure', async () => {
    mutations.remove.mockRejectedValue(new ApiError('Cloudflare said no', 422, { error: { code: 'CLOUDFLARE_ERROR' } }));
    renderTab();

    fireEvent.click(rowButton(td.deleteRecordAriaLabel.replace('{type}', 'A').replace('{name}', 'www.getacme.com')));
    fireEvent.click(await screen.findByRole('button', { name: td.deleteAction }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cloudflare said no'));
  });
});

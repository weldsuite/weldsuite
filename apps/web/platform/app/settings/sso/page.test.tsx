import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { SsoBillingView, SsoConfigView } from '@weldsuite/app-api-client/schemas/sso';

const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.granted.has(permission), isLoading: false }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const api = vi.hoisted(() => ({ sso: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ sso: api.sso }) }));

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/access-denied-empty-state', () => ({
  AccessDeniedEmptyState: ({ permission }: { permission: string }) => <div>No access: {permission}</div>,
}));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import SsoSettingsPage from './page';
import { makeBilling, makeConfig, makeConnection, makeDomain } from './test-support';

const ts = en.settings.sso;

/** The API's answer as the transport hands it over: a fresh copy each time. */
const answer = <T,>(data: T) => ({ data: JSON.parse(JSON.stringify(data)) as T });
const refusal = (status: number, code: string, message = 'English server message') =>
  new ApiError(message, status, { error: { code, message } });

let config: SsoConfigView;
let billing: SsoBillingView;

/** A stand-in for the SSO routes that keeps the state the page reads back. */
function installApi() {
  api.sso.get = vi.fn(async () => answer(config));
  api.sso.billing = vi.fn(async () => answer(billing));
  api.sso.setDomain = vi.fn(async (domain: string) => {
    config = {
      ...config,
      domain: makeDomain({
        name: domain,
        dnsRecord: { type: 'TXT', name: `_weldsuite-sso.${domain}`, value: 'weldsuite-sso-verification=abc123' },
      }),
    };
    return answer(config);
  });
  api.sso.removeDomain = vi.fn(async () => {
    config = { ...config, domain: null };
    return answer(config);
  });
  api.sso.verifyDomain = vi.fn(async () => {
    config = { ...config, domain: makeDomain({ ...config.domain!, verified: true, verifiedAt: '2026-10-21T10:00:00.000Z' }) };
    return answer(config);
  });
  api.sso.saveConnection = vi.fn(async (input: { provider: 'saml_okta'; idpMetadataUrl?: string }) => {
    const current = config.connection ?? makeConnection();
    config = {
      ...config,
      connection: makeConnection({
        ...current,
        provider: input.provider,
        idp: input.idpMetadataUrl ? { ...current.idp, metadataUrl: input.idpMetadataUrl } : current.idp,
        idpConfigured: Boolean(input.idpMetadataUrl) || current.idpConfigured,
        updatedAt: new Date().toISOString(),
      }),
    };
    return answer(config);
  });
  api.sso.removeConnection = vi.fn(async () => {
    config = { ...config, connection: null };
    return answer(config);
  });
  api.sso.activate = vi.fn(async () => {
    config = { ...config, connection: makeConnection({ ...config.connection!, enabled: true, active: true }) };
    return answer(config);
  });
  api.sso.deactivate = vi.fn(async () => {
    config = { ...config, connection: makeConnection({ ...config.connection!, enabled: false, active: false }) };
    return answer(config);
  });
  api.sso.subscribe = vi.fn(async () => {
    billing = makeBilling({
      purchasable: false,
      entitlement: { entitled: true, source: 'subscription' },
      subscription: { status: 'active', currentPeriodEnd: '2026-11-14T12:00:00.000Z', cancelAtPeriodEnd: false },
    });
    config = { ...config, entitlement: { entitled: true, source: 'subscription' } };
    return answer(billing);
  });
  api.sso.cancel = vi.fn(async () => {
    billing = { ...billing, subscription: { ...billing.subscription!, cancelAtPeriodEnd: true } };
    return answer(billing);
  });
  api.sso.resume = vi.fn(async () => {
    billing = { ...billing, subscription: { ...billing.subscription!, cancelAtPeriodEnd: false } };
    return answer(billing);
  });
}

const OWNER = ['sso:read', 'billing:manage'];

function render(granted: string[] = OWNER) {
  permissions.granted = new Set(granted);
  return renderWithProviders(<SsoSettingsPage />);
}

/** A workspace that has everything up to the identity provider step. */
function entitledWithVerifiedDomain(extra: Partial<SsoConfigView> = {}) {
  config = makeConfig({ domain: makeDomain({ verified: true, verifiedAt: '2026-10-20T10:00:00.000Z' }), ...extra });
  billing = makeBilling({ purchasable: false, entitlement: { entitled: true, source: 'plan' }, unavailableReason: 'INCLUDED_IN_PLAN' });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  config = makeConfig({ entitlement: { entitled: false, source: null } });
  billing = makeBilling();
  installApi();
});

describe('SsoSettingsPage access', () => {
  it('asks for access instead of loading anything when the member cannot read the settings', async () => {
    render([]);
    expect(await screen.findByText('No access: sso:read')).toBeInTheDocument();
    expect(api.sso.get).not.toHaveBeenCalled();
  });

  it('says so, and offers a retry, when the settings cannot be loaded', async () => {
    const user = userEvent.setup();
    api.sso.get = vi.fn().mockRejectedValueOnce(refusal(500, 'INTERNAL')).mockResolvedValue(answer(config));
    render();

    expect(await screen.findByText(ts.loadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ts.retry }));
    expect(await screen.findByRole('heading', { name: ts.domain.title })).toBeInTheDocument();
  });

  it('shows a read-only page, without any way to change anything, to someone who may only look', async () => {
    config = makeConfig({
      canManage: false,
      domain: makeDomain({ verified: false }),
    });
    render(['sso:read']);

    expect(await screen.findByText(ts.readOnlyNotice)).toBeInTheDocument();
    // The record to add is still readable, but there is nobody to verify or change it.
    expect(screen.getByRole('textbox', { name: ts.domain.recordValue })).toHaveTextContent('weldsuite-sso-verification=');
    expect(screen.queryByRole('button', { name: ts.domain.verify })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ts.domain.change })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ts.domain.remove })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: ts.activate.label })).toBeDisabled();
  });

  it('shows the read-only identity provider summary, not the form', async () => {
    entitledWithVerifiedDomain({
      canManage: false,
      connection: makeConnection({
        idpConfigured: true,
        idp: { metadataUrl: 'https://idp.example.com/metadata', hasMetadata: false, entityId: 'urn:idp', ssoUrl: null, hasCertificate: true },
      }),
    });
    render(['sso:read']);

    const step = await screen.findByRole('region', { name: ts.connection.title });
    expect(within(step).getByText('https://idp.example.com/metadata')).toBeInTheDocument();
    expect(within(step).queryByRole('button', { name: ts.connection.save })).not.toBeInTheDocument();
    expect(within(step).queryByRole('button', { name: ts.connection.remove })).not.toBeInTheDocument();
    // The values for the identity provider can still be copied.
    expect(within(step).getByRole('textbox', { name: ts.connection.acsUrl })).toHaveTextContent('/saml/acs/');
  });
});

describe('SsoAddonCard', () => {
  it('lets the owner add the add-on after confirming the monthly charge', async () => {
    const user = userEvent.setup();
    render();

    expect(await screen.findByText('€100.00 per month')).toBeInTheDocument();
    expect(screen.getByText(ts.status.notSetUp)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ts.addon.add }));
    const dialog = await screen.findByRole('dialog', { name: ts.addon.confirmAdd.title });
    expect(within(dialog).getByText(/charged €100\.00 per month, starting today/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: ts.addon.confirmAdd.confirm }));

    await waitFor(() => expect(api.sso.subscribe).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(ts.addon.added);
    expect(await screen.findByText('Renews on November 14, 2026')).toBeInTheDocument();
    // The workspace is entitled now, so the configuration was read again.
    await waitFor(() => expect(api.sso.get.mock.calls.length).toBeGreaterThan(1));
  });

  it('keeps a failed payment on the card, in words the owner can act on', async () => {
    const user = userEvent.setup();
    api.sso.subscribe = vi.fn().mockRejectedValue(refusal(402, 'PAYMENT_FAILED'));
    render();

    await user.click(await screen.findByRole('button', { name: ts.addon.add }));
    const dialog = await screen.findByRole('dialog', { name: ts.addon.confirmAdd.title });
    await user.click(within(dialog).getByRole('button', { name: ts.addon.confirmAdd.confirm }));

    expect(await screen.findByText(ts.errors.paymentFailed)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('sends a workspace without a card to billing', async () => {
    billing = makeBilling({ hasPaymentMethod: false });
    render();

    const link = await screen.findByRole('link', { name: ts.addon.addPaymentMethod });
    expect(link).toHaveAttribute('href', '/settings/billing');
    expect(screen.getByText(ts.addon.needsCard)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ts.addon.add })).not.toBeInTheDocument();
  });

  it('tells someone without billing access to ask the owner', async () => {
    render(['sso:read']);

    expect(await screen.findByText(ts.addon.ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ts.addon.add })).not.toBeInTheDocument();
  });

  it('notes a custom price', async () => {
    billing = makeBilling({ price: { unitAmountCents: 4_900, currency: 'usd', custom: true } });
    render();

    expect(await screen.findByText('$49.00 per month')).toBeInTheDocument();
    expect(screen.getByText(ts.addon.customPrice)).toBeInTheDocument();
  });

  it.each([
    ['INCLUDED_IN_PLAN', ts.addon.includedInPlan],
    ['FREE_GRANT', ts.addon.freeGrant],
  ] as const)('shows %s as a badge, with nothing to buy', async (reason, label) => {
    billing = makeBilling({ purchasable: false, unavailableReason: reason });
    render();

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ts.addon.add })).not.toBeInTheDocument();
  });

  it('points a free plan to the plans page, and a partner-billed workspace to its partner', async () => {
    billing = makeBilling({ purchasable: false, unavailableReason: 'FREE_PLAN' });
    const { unmount } = render();
    expect(await screen.findByRole('link', { name: ts.addon.viewPlans })).toHaveAttribute('href', '/settings/plans');
    unmount();

    billing = makeBilling({ purchasable: false, unavailableReason: 'PARTNER_MANAGED' });
    render();
    expect(await screen.findByText(ts.addon.partner)).toBeInTheDocument();
  });

  it('cancels at the end of the period, then resumes', async () => {
    const user = userEvent.setup();
    billing = makeBilling({
      purchasable: false,
      entitlement: { entitled: true, source: 'subscription' },
      subscription: { status: 'active', currentPeriodEnd: '2026-11-14T12:00:00.000Z', cancelAtPeriodEnd: false },
    });
    config = makeConfig({ entitlement: { entitled: true, source: 'subscription' } });
    render();

    await user.click(await screen.findByRole('button', { name: ts.addon.cancel }));
    const dialog = await screen.findByRole('dialog', { name: ts.addon.confirmCancel.title });
    expect(within(dialog).getByText(/until November 14, 2026/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: ts.addon.confirmCancel.confirm }));

    await waitFor(() => expect(api.sso.cancel).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(ts.addon.cancelled);
    expect(await screen.findByText('Ends on November 14, 2026')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ts.addon.resume }));
    await waitFor(() => expect(api.sso.resume).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Renews on November 14, 2026')).toBeInTheDocument();
  });

  it('warns about a payment that failed', async () => {
    billing = makeBilling({
      purchasable: false,
      subscription: { status: 'past_due', currentPeriodEnd: '2026-11-14T12:00:00.000Z', cancelAtPeriodEnd: false },
    });
    render();

    expect(await screen.findByText(ts.addon.pastDue)).toBeInTheDocument();
    expect(screen.getByText(ts.addon.pastDueDescription, { exact: false })).toBeInTheDocument();
  });
});

describe('SsoDomainStep', () => {
  it('claims a domain typed the way people type it, then shows the record to add', async () => {
    const user = userEvent.setup();
    config = makeConfig();
    render();

    const step = await screen.findByRole('region', { name: ts.domain.title });
    await user.type(within(step).getByLabelText(ts.domain.label), ' https://Acme.com/ ');
    await user.click(within(step).getByRole('button', { name: ts.domain.save }));

    await waitFor(() => expect(api.sso.setDomain).toHaveBeenCalledWith('acme.com'));
    expect(toast.success).toHaveBeenCalledWith(ts.domain.saved);
    expect(await within(step).findByRole('textbox', { name: ts.domain.recordName })).toHaveTextContent('_weldsuite-sso.acme.com');
    expect(within(step).getByRole('textbox', { name: ts.domain.recordValue })).toHaveTextContent('weldsuite-sso-verification=abc123');
    expect(within(step).getByRole('button', { name: ts.domain.verify })).toBeInTheDocument();
  });

  it('refuses a public mailbox domain before asking the server', async () => {
    const user = userEvent.setup();
    config = makeConfig();
    render();

    const step = await screen.findByRole('region', { name: ts.domain.title });
    await user.type(within(step).getByLabelText(ts.domain.label), 'gmail.com');
    await user.click(within(step).getByRole('button', { name: ts.domain.save }));

    expect(await within(step).findByText(ts.errors.domainPublic)).toBeInTheDocument();
    expect(api.sso.setDomain).not.toHaveBeenCalled();
  });

  it('shows the server refusal on the field when another workspace owns the domain', async () => {
    const user = userEvent.setup();
    api.sso.setDomain = vi.fn().mockRejectedValue(refusal(409, 'SSO_DOMAIN_IN_USE'));
    config = makeConfig();
    render();

    const step = await screen.findByRole('region', { name: ts.domain.title });
    await user.type(within(step).getByLabelText(ts.domain.label), 'acme.com');
    await user.click(within(step).getByRole('button', { name: ts.domain.save }));

    expect(await within(step).findByText(ts.errors.domainInUse)).toBeInTheDocument();
  });

  it('says the record was not found yet, and verifies once it is there', async () => {
    const user = userEvent.setup();
    config = makeConfig({ domain: makeDomain() });
    api.sso.verifyDomain = vi
      .fn()
      .mockRejectedValueOnce(refusal(422, 'SSO_DOMAIN_NOT_VERIFIED'))
      .mockImplementation(async () => {
        config = { ...config, domain: makeDomain({ verified: true, verifiedAt: '2026-10-21T10:00:00.000Z' }) };
        return answer(config);
      });
    render();

    const step = await screen.findByRole('region', { name: ts.domain.title });
    await user.click(within(step).getByRole('button', { name: ts.domain.verify }));
    expect(await within(step).findByText(ts.errors.domainRecordNotFound)).toBeInTheDocument();

    await user.click(within(step).getByRole('button', { name: ts.domain.verify }));
    expect(await within(step).findByText(ts.domain.verified)).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(ts.domain.verifiedToast);
    expect(within(step).queryByRole('textbox', { name: ts.domain.recordName })).not.toBeInTheDocument();
    expect(within(step).queryByText(ts.errors.domainRecordNotFound)).not.toBeInTheDocument();
  });

  it('cannot change or remove the domain while a connection uses it', async () => {
    entitledWithVerifiedDomain({ connection: makeConnection() });
    render();

    const step = await screen.findByRole('region', { name: ts.domain.title });
    expect(within(step).getByRole('button', { name: ts.domain.change })).toBeDisabled();
    expect(within(step).getByRole('button', { name: ts.domain.remove })).toBeDisabled();
    expect(within(step).getByText(ts.domain.lockedHint)).toBeInTheDocument();
  });

  it('removes the domain after a confirmation', async () => {
    const user = userEvent.setup();
    config = makeConfig({ domain: makeDomain() });
    render();

    const step = await screen.findByRole('region', { name: ts.domain.title });
    await user.click(within(step).getByRole('button', { name: ts.domain.remove }));
    const dialog = await screen.findByRole('dialog', { name: ts.domain.removeConfirmTitle });
    await user.click(within(dialog).getByRole('button', { name: ts.domain.remove }));

    await waitFor(() => expect(api.sso.removeDomain).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(ts.domain.removed);
    expect(await within(step).findByLabelText(ts.domain.label)).toBeInTheDocument();
  });
});

describe('SsoConnectionStep', () => {
  it('waits for the add-on, then for a verified domain', async () => {
    config = makeConfig({ entitlement: { entitled: false, source: null }, domain: makeDomain({ verified: true }) });
    const { unmount } = render();
    const waiting = await screen.findByRole('region', { name: ts.connection.title });
    expect(within(waiting).getByText(ts.connection.needsEntitlement)).toBeInTheDocument();
    unmount();

    config = makeConfig({ domain: makeDomain({ verified: false }) });
    render();
    const unverified = await screen.findByRole('region', { name: ts.connection.title });
    expect(within(unverified).getByText(ts.connection.needsDomain)).toBeInTheDocument();
  });

  it('creates the connection first, then asks for the identity provider details', async () => {
    const user = userEvent.setup();
    entitledWithVerifiedDomain();
    render();

    const step = await screen.findByRole('region', { name: ts.connection.title });
    expect(within(step).getByRole('button', { name: ts.connection.create })).toBeDisabled();
    await user.click(within(step).getByRole('combobox', { name: ts.connection.provider }));
    await user.click(await screen.findByRole('option', { name: 'Okta' }));
    await user.click(within(step).getByRole('button', { name: ts.connection.create }));

    await waitFor(() => expect(api.sso.saveConnection).toHaveBeenCalledWith({ provider: 'saml_okta' }));
    expect(toast.success).toHaveBeenCalledWith(ts.connection.created);

    // The values to enter in the identity provider, each with a copy button.
    expect(await within(step).findByRole('textbox', { name: ts.connection.acsUrl })).toHaveTextContent(
      'https://clerk.weldsuite.org/v1/saml/acs/samlc_1',
    );
    expect(within(step).getByRole('textbox', { name: ts.connection.spEntityId })).toBeInTheDocument();
    expect(within(step).getByRole('textbox', { name: ts.connection.spMetadataUrl })).toBeInTheDocument();
    expect(within(step).getByRole('button', { name: `Copy ${ts.connection.acsUrl}` })).toBeInTheDocument();
    expect(within(step).getByText(ts.connection.incomplete)).toBeInTheDocument();
  });

  it('copies a value to the clipboard', async () => {
    const user = userEvent.setup();
    entitledWithVerifiedDomain({ connection: makeConnection() });
    render();

    const step = await screen.findByRole('region', { name: ts.connection.title });
    await user.click(within(step).getByRole('button', { name: `Copy ${ts.connection.acsUrl}` }));
    expect(await within(step).findByTitle(ts.copied)).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('https://clerk.weldsuite.org/v1/saml/acs/samlc_1');
  });

  it('checks the metadata URL, then saves the identity provider', async () => {
    const user = userEvent.setup();
    entitledWithVerifiedDomain({ connection: makeConnection() });
    render();

    const step = await screen.findByRole('region', { name: ts.connection.title });
    const url = within(step).getByLabelText(ts.connection.metadataUrl);

    await user.type(url, 'http://idp.example.com/metadata');
    await user.click(within(step).getByRole('button', { name: ts.connection.save }));
    expect(await within(step).findByText(ts.validation.httpsUrl)).toBeInTheDocument();
    expect(api.sso.saveConnection).not.toHaveBeenCalled();

    await user.clear(url);
    await user.type(url, 'https://idp.example.com/metadata');
    await user.click(within(step).getByRole('button', { name: ts.connection.save }));

    await waitFor(() =>
      expect(api.sso.saveConnection).toHaveBeenCalledWith({
        provider: 'saml_okta',
        idpMetadataUrl: 'https://idp.example.com/metadata',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(ts.connection.saved);
    expect(await within(step).findByText(ts.connection.complete)).toBeInTheDocument();
  });

  it('shows why the identity provider details were refused', async () => {
    const user = userEvent.setup();
    api.sso.saveConnection = vi.fn().mockRejectedValue(refusal(422, 'SSO_IDP_REJECTED', 'idp_metadata_url could not be fetched'));
    entitledWithVerifiedDomain({ connection: makeConnection() });
    render();

    const step = await screen.findByRole('region', { name: ts.connection.title });
    await user.type(within(step).getByLabelText(ts.connection.metadataUrl), 'https://idp.example.com/metadata');
    await user.click(within(step).getByRole('button', { name: ts.connection.save }));

    expect(
      await within(step).findByText('Your identity provider details were not accepted: idp_metadata_url could not be fetched'),
    ).toBeInTheDocument();
  });

  it('asks for the entity id, sign-on URL and certificate on the manual method', async () => {
    const user = userEvent.setup();
    entitledWithVerifiedDomain({ connection: makeConnection() });
    render();

    const step = await screen.findByRole('region', { name: ts.connection.title });
    await user.click(within(step).getByRole('radio', { name: ts.connection.method.manual }));
    await user.click(within(step).getByRole('button', { name: ts.connection.save }));

    expect(await within(step).findAllByText(ts.validation.required)).toHaveLength(3);
    expect(api.sso.saveConnection).not.toHaveBeenCalled();

    await user.type(within(step).getByLabelText(ts.connection.entityId), 'urn:idp');
    await user.type(within(step).getByLabelText(ts.connection.ssoUrl), 'https://idp.example.com/sso');
    await user.type(within(step).getByLabelText(ts.connection.certificate), 'MIICert');
    await user.click(within(step).getByRole('button', { name: ts.connection.save }));

    await waitFor(() =>
      expect(api.sso.saveConnection).toHaveBeenCalledWith({
        provider: 'saml_okta',
        idpEntityId: 'urn:idp',
        idpSsoUrl: 'https://idp.example.com/sso',
        idpCertificate: 'MIICert',
      }),
    );
  });

  it('shows how many people signed in through it, and removes it after a confirmation', async () => {
    const user = userEvent.setup();
    entitledWithVerifiedDomain({ connection: makeConnection({ userCount: 3, idpConfigured: true }) });
    render();

    const step = await screen.findByRole('region', { name: ts.connection.title });
    expect(within(step).getByText('3 people have signed in through this connection.')).toBeInTheDocument();

    await user.click(within(step).getByRole('button', { name: ts.connection.remove }));
    const dialog = await screen.findByRole('dialog', { name: ts.connection.removeConfirmTitle });
    expect(within(dialog).getByText(/people at acme\.com sign in without/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: ts.connection.remove }));

    await waitFor(() => expect(api.sso.removeConnection).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(ts.connection.removed);
    expect(await within(step).findByRole('button', { name: ts.connection.create })).toBeInTheDocument();
  });
});

describe('SsoActivateStep', () => {
  it('cannot be switched on until the identity provider has its details', async () => {
    entitledWithVerifiedDomain({ connection: makeConnection({ idpConfigured: false }) });
    render();

    const step = await screen.findByRole('region', { name: ts.activate.title });
    expect(within(step).getByRole('switch', { name: ts.activate.label })).toBeDisabled();
    expect(within(step).getByText(ts.activate.blocked.idp_incomplete)).toBeInTheDocument();
  });

  it('warns, then switches on after a confirmation; switching off needs none', async () => {
    const user = userEvent.setup();
    entitledWithVerifiedDomain({ connection: makeConnection({ idpConfigured: true }) });
    render();

    const step = await screen.findByRole('region', { name: ts.activate.title });
    const toggle = within(step).getByRole('switch', { name: ts.activate.label });
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: ts.activate.confirmTitle });
    expect(within(dialog).getByText(/everyone with an email address at acme\.com has to sign in through your identity provider/)).toBeInTheDocument();
    expect(within(dialog).getByText(/test the sign-in in a private window/)).toBeInTheDocument();
    expect(api.sso.activate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: ts.activate.confirm }));

    await waitFor(() => expect(api.sso.activate).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(ts.activate.switchedOn);
    await waitFor(() => expect(within(step).getByRole('switch', { name: ts.activate.label })).toBeChecked());
    // The page header and this step both say it is active now.
    expect(screen.getAllByText(ts.status.active)).toHaveLength(2);
    expect(within(step).getByText(ts.activate.offHint)).toBeInTheDocument();

    await user.click(within(step).getByRole('switch', { name: ts.activate.label }));
    await waitFor(() => expect(api.sso.deactivate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(ts.activate.switchedOff);
  });

  it('can always be switched off, and says when it is paused because the add-on ended', async () => {
    config = makeConfig({
      entitlement: { entitled: false, source: null },
      domain: makeDomain({ verified: true }),
      connection: makeConnection({ idpConfigured: true, enabled: true, active: false }),
    });
    billing = makeBilling();
    render();

    const step = await screen.findByRole('region', { name: ts.activate.title });
    expect(within(step).getByRole('switch', { name: ts.activate.label })).toBeEnabled();
    expect(within(step).getByText(ts.activate.paused)).toBeInTheDocument();
  });

  it('keeps the failure on the step when the server refuses', async () => {
    const user = userEvent.setup();
    api.sso.activate = vi.fn().mockRejectedValue(refusal(409, 'SSO_IDP_INCOMPLETE'));
    entitledWithVerifiedDomain({ connection: makeConnection({ idpConfigured: true }) });
    render();

    const step = await screen.findByRole('region', { name: ts.activate.title });
    await user.click(within(step).getByRole('switch', { name: ts.activate.label }));
    const dialog = await screen.findByRole('dialog', { name: ts.activate.confirmTitle });
    await user.click(within(dialog).getByRole('button', { name: ts.activate.confirm }));

    expect(await within(step).findByText(ts.errors.idpIncomplete)).toBeInTheDocument();
    expect(within(step).getByRole('switch', { name: ts.activate.label })).not.toBeChecked();
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { SsoConfigView, SsoOidcConnectionInput } from '@weldsuite/app-api-client/schemas/sso';

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
import { makeOidcConnection, makeOidcDomain, makeWeldIdConfig } from './test-support';

const ts = en.settings.sso;
const copy = ts.weldid;
const SECRET = 'very-secret-client-value';

const answer = <T,>(data: T) => ({ data: JSON.parse(JSON.stringify(data)) as T });
const refusal = (status: number, code: string, message = 'English server message') =>
  new ApiError(message, status, { error: { code, message } });

let config: SsoConfigView;

function oidc() {
  return config.oidc!;
}

/** The WeldID-mode routes, keeping the state the page reads back (never the secret). */
function installApi() {
  api.sso.get = vi.fn(async () => answer(config));
  api.sso.billing = vi.fn(async () => {
    throw refusal(502, 'BILLING_UNAVAILABLE');
  });
  api.sso.saveOidcConnection = vi.fn(async (input: SsoOidcConnectionInput) => {
    const current = oidc().connection ?? makeOidcConnection({ hasClientSecret: false });
    config = makeWeldIdConfig({
      ...oidc(),
      defaultRole: input.defaultRole ?? oidc().defaultRole,
      connection: makeOidcConnection({
        ...current,
        displayName: input.displayName ?? current.displayName,
        issuer: input.issuer ?? current.issuer,
        clientId: input.clientId ?? current.clientId,
        scopes: input.scopes ?? current.scopes,
        trustEmails: input.trustEmails ?? current.trustEmails,
        hasClientSecret: current.hasClientSecret || Boolean(input.clientSecret),
        enforceSso: input.enforceSso ?? current.enforceSso,
      }),
    });
    return answer(config);
  });
  api.sso.removeConnection = vi.fn(async () => {
    config = makeWeldIdConfig();
    return answer(config);
  });
  api.sso.addDomain = vi.fn(async (domain: string) => {
    config = makeWeldIdConfig({ ...oidc(), domains: [...oidc().domains, makeOidcDomain({ name: domain })] });
    return answer(config);
  });
  api.sso.verifyConnectionDomain = vi.fn(async (domain: string) => {
    config = makeWeldIdConfig({
      ...oidc(),
      domains: oidc().domains.map((d) =>
        d.name === domain ? makeOidcDomain({ ...d, status: 'verified', verified: true, verifiedAt: '2026-11-16T10:05:00.000Z' }) : d,
      ),
    });
    return answer(config);
  });
  api.sso.removeConnectionDomain = vi.fn(async (domain: string) => {
    config = makeWeldIdConfig({ ...oidc(), domains: oidc().domains.filter((d) => d.name !== domain) });
    return answer(config);
  });
  api.sso.activate = vi.fn(async () => {
    config = makeWeldIdConfig({ ...oidc(), active: true, connection: { ...oidc().connection!, enabled: true } });
    return answer(config);
  });
  api.sso.deactivate = vi.fn(async () => {
    config = makeWeldIdConfig({ ...oidc(), active: false, connection: { ...oidc().connection!, enabled: false } });
    return answer(config);
  });
}

function render(granted: string[] = ['sso:read']) {
  permissions.granted = new Set(granted);
  return renderWithProviders(<SsoSettingsPage />);
}

const step = (title: string) => screen.findByRole('region', { name: title });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  config = makeWeldIdConfig();
  installApi();
});

describe('Single sign-on with WeldID: no connection yet', () => {
  it('shows the OpenID Connect form instead of the add-on and SAML, and blocks the next steps', async () => {
    render();

    const connectionStep = await step(copy.connection.title);
    expect(screen.getByText(copy.samlLater)).toBeInTheDocument();
    expect(screen.getByText(copy.description)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: ts.addon.title })).not.toBeInTheDocument();
    expect(api.sso.billing).not.toHaveBeenCalled();
    expect(screen.queryByText(ts.connection.providers.saml_okta)).not.toBeInTheDocument();
    expect(screen.getByText(ts.status.notSetUp)).toBeInTheDocument();

    expect(within(connectionStep).getByLabelText(copy.connection.issuer)).toBeInTheDocument();
    expect(within(connectionStep).getByLabelText(copy.connection.clientSecret)).toHaveAttribute('type', 'password');
    const domainsStep = await step(copy.domains.title);
    expect(within(domainsStep).getByText(copy.domains.needsConnection)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: copy.signIn.enabled })).toBeDisabled();
    expect(within(await step(copy.signIn.title)).getByText(copy.signIn.blocked.no_connection)).toBeInTheDocument();
  });

  it('checks the form, then creates the connection and shows the redirect URI from WeldID', async () => {
    const user = userEvent.setup();
    render();
    const connectionStep = await step(copy.connection.title);

    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.create }));
    expect(await within(connectionStep).findAllByText(ts.validation.required)).toHaveLength(4);
    expect(api.sso.saveOidcConnection).not.toHaveBeenCalled();

    await user.type(within(connectionStep).getByLabelText(copy.connection.displayName), 'Acme Entra');
    await user.type(within(connectionStep).getByLabelText(copy.connection.issuer), 'http://login.example.test');
    await user.type(within(connectionStep).getByLabelText(copy.connection.clientId), 'client-1');
    await user.type(within(connectionStep).getByLabelText(copy.connection.clientSecret), SECRET);
    await user.type(within(connectionStep).getByLabelText(copy.connection.scopes), 'groups, offline_access');
    await user.click(within(connectionStep).getByRole('checkbox', { name: copy.connection.trustEmails }));
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.create }));
    expect(await within(connectionStep).findByText(ts.validation.httpsUrl)).toBeInTheDocument();

    const issuer = within(connectionStep).getByLabelText(copy.connection.issuer);
    await user.clear(issuer);
    await user.type(issuer, 'https://login.example.test/acme/v2.0');
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.create }));

    await waitFor(() =>
      expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({
        displayName: 'Acme Entra',
        issuer: 'https://login.example.test/acme/v2.0',
        clientId: 'client-1',
        clientSecret: SECRET,
        scopes: ['groups', 'offline_access'],
        trustEmails: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(copy.connection.created);
    expect(await within(connectionStep).findByRole('textbox', { name: copy.connection.redirectUri })).toHaveTextContent(
      'https://auth.example.test/sso/oidc/ssoc_1/callback',
    );
    expect(within(connectionStep).getByText(copy.connection.secretStored)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SECRET);
  });

  it('says why it cannot connect when the plan has no single sign-on', async () => {
    config = makeWeldIdConfig({}, { entitlement: { entitled: false, source: null } });
    render(['sso:read']);

    const connectionStep = await step(copy.connection.title);
    expect(within(connectionStep).getByText(copy.notEntitled)).toBeInTheDocument();
    expect(within(connectionStep).queryByRole('button', { name: copy.connection.create })).not.toBeInTheDocument();
  });
});

describe('Single sign-on with WeldID: a pending domain', () => {
  beforeEach(() => {
    config = makeWeldIdConfig({ connection: makeOidcConnection(), domains: [makeOidcDomain()] });
  });

  it('shows the TXT record to publish, and the record-not-found message from a failed check', async () => {
    const user = userEvent.setup();
    api.sso.verifyConnectionDomain = vi.fn().mockRejectedValueOnce(refusal(422, 'SSO_DOMAIN_NOT_VERIFIED'));
    render();

    const domainsStep = await step(copy.domains.title);
    expect(within(domainsStep).getByText(copy.domains.status.pending)).toBeInTheDocument();
    expect(within(domainsStep).getByRole('textbox', { name: ts.domain.recordName })).toHaveTextContent('_weldsuite-sso.acme.com');
    expect(within(domainsStep).getByRole('textbox', { name: ts.domain.recordValue })).toHaveTextContent(
      'weldsuite-sso-verification=tok1',
    );

    await user.click(within(domainsStep).getByRole('button', { name: copy.domains.verify }));
    await waitFor(() => expect(api.sso.verifyConnectionDomain).toHaveBeenCalledWith('acme.com'));
    expect(await within(domainsStep).findByText(ts.errors.domainRecordNotFound)).toBeInTheDocument();
    // Without a verified domain single sign-on cannot be switched on.
    expect(screen.getByRole('switch', { name: copy.signIn.enabled })).toBeDisabled();
    expect(screen.getByText(copy.signIn.blocked.domain_unverified)).toBeInTheDocument();
  });

  it('adds another domain, refusing a public one first', async () => {
    const user = userEvent.setup();
    render();
    const domainsStep = await step(copy.domains.title);
    const input = within(domainsStep).getByLabelText(copy.domains.label);

    await user.type(input, 'gmail.com');
    await user.click(within(domainsStep).getByRole('button', { name: copy.domains.add }));
    expect(await within(domainsStep).findByText(ts.errors.domainPublic)).toBeInTheDocument();
    expect(api.sso.addDomain).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, 'https://www.Acme.nl/');
    await user.click(within(domainsStep).getByRole('button', { name: copy.domains.add }));
    await waitFor(() => expect(api.sso.addDomain).toHaveBeenCalledWith('acme.nl'));
    expect(await within(domainsStep).findByText('acme.nl')).toBeInTheDocument();
  });

  it('removes a domain after confirming', async () => {
    const user = userEvent.setup();
    render();
    const domainsStep = await step(copy.domains.title);

    await user.click(within(domainsStep).getByRole('button', { name: 'Remove acme.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove acme.com?' });
    await user.click(within(dialog).getByRole('button', { name: copy.domains.remove }));
    await waitFor(() => expect(api.sso.removeConnectionDomain).toHaveBeenCalledWith('acme.com'));
    expect(await within(domainsStep).findByText(copy.domains.none)).toBeInTheDocument();
  });
});

describe('Single sign-on with WeldID: a verified domain', () => {
  beforeEach(() => {
    config = makeWeldIdConfig({
      connection: makeOidcConnection(),
      domains: [makeOidcDomain({ status: 'verified', verified: true, verifiedAt: '2026-11-16T10:05:00.000Z' })],
    });
  });

  it('hides the record, and switches single sign-on on after confirming', async () => {
    const user = userEvent.setup();
    render();

    const domainsStep = await step(copy.domains.title);
    expect(within(domainsStep).getAllByText(copy.domains.status.verified).length).toBeGreaterThan(0);
    expect(within(domainsStep).queryByRole('textbox', { name: ts.domain.recordValue })).not.toBeInTheDocument();
    expect(within(domainsStep).queryByRole('button', { name: copy.domains.verify })).not.toBeInTheDocument();

    const toggle = screen.getByRole('switch', { name: copy.signIn.enabled });
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: copy.signIn.confirmOnTitle });
    expect(within(dialog).getByText(/acme\.com/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: copy.signIn.confirmOn }));

    await waitFor(() => expect(api.sso.activate).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(copy.signIn.switchedOn);
    expect(await screen.findByRole('switch', { name: copy.signIn.enabled })).toBeChecked();
    expect(screen.getAllByText(ts.status.active).length).toBeGreaterThan(0);
  });

  it('edits the connection without the secret, sending only what changed', async () => {
    const user = userEvent.setup();
    render();
    const connectionStep = await step(copy.connection.title);

    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    const secret = within(connectionStep).getByLabelText(copy.connection.clientSecret);
    expect(secret).toHaveValue('');
    expect(within(connectionStep).getByText(copy.connection.clientSecretStored)).toBeInTheDocument();
    const name = within(connectionStep).getByLabelText(copy.connection.displayName);
    await user.clear(name);
    await user.type(name, 'Entra ID');
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.save }));

    await waitFor(() => expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({ displayName: 'Entra ID' }));
  });

  it('sets the role new members join with', async () => {
    const user = userEvent.setup();
    render();
    await step(copy.signIn.title);

    await user.click(screen.getByRole('combobox', { name: copy.signIn.defaultRole }));
    await user.click(await screen.findByRole('option', { name: copy.signIn.roles.VIEWER }));
    await waitFor(() => expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({ defaultRole: 'VIEWER' }));
    expect(toast.success).toHaveBeenCalledWith(copy.signIn.roleSaved);
  });
});

describe('Single sign-on with WeldID: requiring it', () => {
  beforeEach(() => {
    config = makeWeldIdConfig({
      active: true,
      connection: makeOidcConnection({ enabled: true }),
      domains: [makeOidcDomain({ status: 'verified', verified: true, verifiedAt: '2026-11-16T10:05:00.000Z' })],
    });
  });

  it('warns before requiring single sign-on, and keeps the warning in view while it is required', async () => {
    const user = userEvent.setup();
    render();
    await step(copy.signIn.title);
    expect(screen.queryByText(copy.signIn.enforceWarning)).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: copy.signIn.enforce }));
    const dialog = await screen.findByRole('dialog', { name: copy.signIn.confirmEnforceTitle });
    expect(within(dialog).getByText(copy.signIn.enforceWarning)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: copy.signIn.confirmEnforce }));

    await waitFor(() => expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({ enforceSso: true }));
    expect(toast.success).toHaveBeenCalledWith(copy.signIn.enforcedOn);
    expect(await screen.findByRole('switch', { name: copy.signIn.enforce })).toBeChecked();
    expect(screen.getByText(copy.signIn.enforceWarning)).toBeInTheDocument();
  });

  it('stops requiring it at once, without asking', async () => {
    const user = userEvent.setup();
    config = makeWeldIdConfig({ ...config.oidc!, connection: makeOidcConnection({ enabled: true, enforceSso: true }) });
    render();
    await step(copy.signIn.title);

    await user.click(screen.getByRole('switch', { name: copy.signIn.enforce }));
    await waitFor(() => expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({ enforceSso: false }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a reader everything but lets them change nothing', async () => {
    config = { ...config, canManage: false };
    render(['sso:read']);

    const connectionStep = await step(copy.connection.title);
    expect(screen.getByText(ts.readOnlyNotice)).toBeInTheDocument();
    expect(within(connectionStep).queryByRole('button', { name: ts.domain.change })).not.toBeInTheDocument();
    expect(within(connectionStep).getByRole('textbox', { name: copy.connection.redirectUri })).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.domains.label)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: copy.signIn.enabled })).toBeDisabled();
    expect(screen.getByRole('switch', { name: copy.signIn.enforce })).toBeDisabled();
  });
});

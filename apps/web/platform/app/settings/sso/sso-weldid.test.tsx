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
import { makeOidcConnection, makeOidcDomain, makeSamlConnection, makeWeldIdConfig } from './test-support';

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
    const saved = oidc().connection;
    if (input.protocol === 'saml' || saved?.protocol === 'saml') {
      const current = saved ?? makeSamlConnection();
      config = makeWeldIdConfig({
        ...oidc(),
        connection: makeSamlConnection({
          ...current,
          displayName: input.displayName ?? current.displayName,
          trustEmails: input.trustEmails ?? current.trustEmails,
          saml: { ...current.saml!, idpMetadataUrl: input.metadataXml ? null : (input.metadataUrl ?? current.saml!.idpMetadataUrl) },
        }),
      });
      return answer(config);
    }
    const current = saved ?? makeOidcConnection({ hasClientSecret: false });
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
  it('offers OpenID Connect (the default) or SAML instead of the add-on, and blocks the next steps', async () => {
    render();

    const connectionStep = await step(copy.connection.title);
    expect(within(connectionStep).getByRole('radio', { name: new RegExp(copy.connection.protocolOidc) })).toBeChecked();
    expect(within(connectionStep).getByRole('radio', { name: new RegExp(copy.connection.protocolSaml) })).not.toBeChecked();
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

  it('creates a SAML connection from a metadata URL and shows what to register at the identity provider', async () => {
    const user = userEvent.setup();
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);

    await user.click(within(connectionStep).getByRole('radio', { name: new RegExp(copy.connection.protocolSaml) }));
    expect(within(connectionStep).queryByLabelText(copy.connection.clientSecret)).not.toBeInTheDocument();
    // SAML has no verified-email flag: trusting the provider is on by default.
    expect(within(connectionStep).getByRole('checkbox', { name: copy.connection.trustEmails })).toBeChecked();

    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.create }));
    expect(await within(connectionStep).findByText(copy.connection.metadataRequired)).toBeInTheDocument();
    expect(api.sso.saveOidcConnection).not.toHaveBeenCalled();

    await user.type(within(connectionStep).getByLabelText(copy.connection.displayName), 'Acme SAML');
    await user.type(within(connectionStep).getByLabelText(copy.connection.metadataUrl), 'http://idp.example.test/m.xml');
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.create }));
    expect(await within(connectionStep).findByText(ts.validation.httpsUrl)).toBeInTheDocument();

    const url = within(connectionStep).getByLabelText(copy.connection.metadataUrl);
    await user.clear(url);
    await user.type(url, 'https://login.microsoftonline.com/acme/federationmetadata.xml');
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.create }));

    await waitFor(() =>
      expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({
        protocol: 'saml',
        displayName: 'Acme SAML',
        trustEmails: true,
        metadataUrl: 'https://login.microsoftonline.com/acme/federationmetadata.xml',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(copy.connection.samlCreated);
    expect(await within(connectionStep).findByRole('textbox', { name: copy.connection.spEntityId })).toHaveTextContent(
      'https://auth.example.test/sso/ssoc_1/saml/metadata',
    );
    expect(within(connectionStep).getByRole('textbox', { name: copy.connection.spAcsUrl })).toHaveTextContent(
      'https://auth.example.test/sso/ssoc_1/saml/acs',
    );
    expect(within(connectionStep).getByText('AB:CD:EF')).toBeInTheDocument();
    expect(within(connectionStep).queryByText(copy.connection.redirectTitle)).not.toBeInTheDocument();
  });

  it('shows WeldID’s refusal of SAML metadata as WeldID wrote it', async () => {
    const user = userEvent.setup();
    api.sso.saveOidcConnection = vi
      .fn()
      .mockRejectedValueOnce(refusal(400, 'SSO_IDP_REJECTED', 'The metadata has no signing certificate.'));
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);
    await user.click(within(connectionStep).getByRole('radio', { name: new RegExp(copy.connection.protocolSaml) }));
    await user.type(within(connectionStep).getByLabelText(copy.connection.displayName), 'Acme SAML');
    await user.type(within(connectionStep).getByLabelText(copy.connection.metadataUrl), 'https://idp.example.test/m.xml');
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.create }));
    expect(await within(connectionStep).findByText(/The metadata has no signing certificate\./)).toBeInTheDocument();
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

describe('Single sign-on with WeldID: a SAML connection', () => {
  const metadata =
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sts.windows.net/acme/"/>';

  beforeEach(() => {
    config = makeWeldIdConfig({ connection: makeSamlConnection(), domains: [makeOidcDomain()] });
  });

  it('shows what WeldID read from the metadata and what to register, never a redirect URI', async () => {
    config = { ...config, canManage: false };
    render(['sso:read']);
    const connectionStep = await step(copy.connection.title);
    expect(within(connectionStep).getByText(copy.connection.protocolSaml)).toBeInTheDocument();
    expect(within(connectionStep).getByText('https://sts.windows.net/acme/')).toBeInTheDocument();
    expect(within(connectionStep).getByText('https://login.microsoftonline.com/acme/saml2')).toBeInTheDocument();
    expect(
      within(connectionStep).getByText('https://login.microsoftonline.com/acme/federationmetadata.xml'),
    ).toBeInTheDocument();
    expect(within(connectionStep).getByText('AB:CD:EF')).toBeInTheDocument();
    expect(within(connectionStep).getByText(/^Expires /)).toBeInTheDocument();
    expect(within(connectionStep).getByText(copy.connection.trustEmailsOn)).toBeInTheDocument();
    expect(within(connectionStep).getByRole('textbox', { name: copy.connection.spMetadataUrl })).toHaveTextContent(
      'https://auth.example.test/sso/ssoc_1/saml/metadata',
    );
    expect(within(connectionStep).queryByText(copy.connection.redirectTitle)).not.toBeInTheDocument();
    // Read only: nothing to change.
    expect(within(connectionStep).queryByRole('button', { name: ts.domain.change })).not.toBeInTheDocument();
  });

  it('says the metadata was uploaded when it came from a file', async () => {
    config = makeWeldIdConfig({
      connection: makeSamlConnection({ saml: { ...makeSamlConnection().saml!, idpMetadataUrl: null, idpCertificates: [] } }),
    });
    render(['sso:read']);
    const connectionStep = await step(copy.connection.title);
    expect(within(connectionStep).getByText(copy.connection.idpMetadataUploaded)).toBeInTheDocument();
  });

  it('fetches the metadata again from the same URL', async () => {
    const user = userEvent.setup();
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);
    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    expect(within(connectionStep).getByLabelText(copy.connection.metadataUrl)).toHaveValue(
      'https://login.microsoftonline.com/acme/federationmetadata.xml',
    );
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.save }));
    await waitFor(() =>
      expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({
        metadataUrl: 'https://login.microsoftonline.com/acme/federationmetadata.xml',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(copy.connection.metadataRefetched);
  });

  it('replaces the metadata with an uploaded file, refusing one that is too large', async () => {
    const user = userEvent.setup();
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);
    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    await user.click(within(connectionStep).getByRole('radio', { name: copy.connection.metadataFromFile }));

    const input = within(connectionStep).getByLabelText(copy.connection.metadataFile);
    const tooLarge = new File(['x'.repeat(256 * 1024 + 1)], 'huge.xml', { type: 'text/xml' });
    await user.upload(input, tooLarge);
    expect(await within(connectionStep).findByText(copy.connection.metadataFileTooLarge)).toBeInTheDocument();

    await user.upload(input, new File([metadata], 'acme.xml', { type: 'text/xml' }));
    expect(
      await within(connectionStep).findByText(copy.connection.metadataFileChosen.replace('{name}', 'acme.xml')),
    ).toBeInTheDocument();
    const name = within(connectionStep).getByLabelText(copy.connection.displayName);
    await user.clear(name);
    await user.type(name, 'Acme Entra SAML');
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.save }));
    await waitFor(() =>
      expect(api.sso.saveOidcConnection).toHaveBeenCalledWith({ metadataXml: metadata, displayName: 'Acme Entra SAML' }),
    );
    expect(toast.success).toHaveBeenCalledWith(copy.connection.saved);
    expect(await within(connectionStep).findByText(copy.connection.idpMetadataUploaded)).toBeInTheDocument();
  });

  it('closes the form without a request when nothing changed, and on Cancel', async () => {
    const user = userEvent.setup();
    config = makeWeldIdConfig({
      connection: makeSamlConnection({ saml: { ...makeSamlConnection().saml!, idpMetadataUrl: null } }),
    });
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);
    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.save }));
    expect(await within(connectionStep).findByRole('button', { name: ts.domain.change })).toBeInTheDocument();
    expect(api.sso.saveOidcConnection).not.toHaveBeenCalled();

    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    await user.click(within(connectionStep).getByRole('button', { name: en.common.actions.cancel }));
    expect(await within(connectionStep).findByRole('button', { name: ts.domain.change })).toBeInTheDocument();
  });

  it('removes the connection after confirming, and says why when it cannot', async () => {
    const user = userEvent.setup();
    api.sso.removeConnection = vi
      .fn()
      .mockRejectedValueOnce(refusal(502, 'SSO_PROVIDER_UNAVAILABLE'))
      .mockImplementationOnce(async () => {
        config = makeWeldIdConfig();
        return answer(config);
      });
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);

    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.remove }));
    await user.click(
      within(await screen.findByRole('dialog', { name: copy.connection.removeConfirmTitle })).getByRole('button', {
        name: copy.connection.remove,
      }),
    );
    expect(await within(connectionStep).findByText(ts.errors.providerUnavailable)).toBeInTheDocument();

    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.remove }));
    await user.click(
      within(await screen.findByRole('dialog', { name: copy.connection.removeConfirmTitle })).getByRole('button', {
        name: copy.connection.remove,
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(copy.connection.removed));
    expect(await within(connectionStep).findByRole('radio', { name: new RegExp(copy.connection.protocolSaml) })).toBeInTheDocument();
  });

  it('closes the OpenID Connect form without a request when nothing changed, and shows a refusal', async () => {
    const user = userEvent.setup();
    config = makeWeldIdConfig({ connection: makeOidcConnection() });
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);
    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.save }));
    expect(await within(connectionStep).findByRole('button', { name: ts.domain.change })).toBeInTheDocument();
    expect(api.sso.saveOidcConnection).not.toHaveBeenCalled();

    api.sso.saveOidcConnection = vi
      .fn()
      .mockRejectedValueOnce(refusal(400, 'SSO_IDP_REJECTED', 'Issuer discovery failed.'));
    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    await user.type(within(connectionStep).getByLabelText(copy.connection.clientId), '-2');
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.save }));
    expect(await within(connectionStep).findByText(/Issuer discovery failed\./)).toBeInTheDocument();
  });

  it('shows the switch refusal when the server keeps the protocol', async () => {
    const user = userEvent.setup();
    api.sso.saveOidcConnection = vi.fn().mockRejectedValueOnce(refusal(409, 'SSO_PROTOCOL_MISMATCH'));
    render(['sso:read', 'sso:manage']);
    const connectionStep = await step(copy.connection.title);
    await user.click(within(connectionStep).getByRole('button', { name: ts.domain.change }));
    await user.click(within(connectionStep).getByRole('button', { name: copy.connection.save }));
    expect(await within(connectionStep).findByText(ts.errors.protocolMismatch)).toBeInTheDocument();
  });
});

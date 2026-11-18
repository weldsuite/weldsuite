/**
 * Pure rules of Settings > Single sign-on: what the status badge says, which
 * state the add-on card is in, whether SSO can be switched on, and how the
 * identity provider form maps to `PUT /api/sso/connection`. Kept out of the
 * components so they can be unit tested.
 */

import {
  areSsoScopesValid,
  isPublicEmailDomain,
  normalizeSsoDomain,
  parseSsoScopes,
  type SsoBillingView,
  type SsoConfigView,
  type SsoConnectionInput,
  type SsoOidcConnectionInput,
  type SsoOidcView,
  type SsoProviderId,
} from '@weldsuite/app-api-client/schemas/sso';

export type SsoConnection = NonNullable<SsoConfigView['connection']>;
export type SsoIdp = SsoConnection['idp'];

// ============================================================================
// Status
// ============================================================================

export type SsoStatus = 'active' | 'off' | 'not_set_up';

/**
 * `active`: Clerk is sending the domain's people to the identity provider now.
 * `off`: a working connection exists but is switched off (or paused because
 * the add-on ended). `not_set_up`: nothing that could sign anyone in yet.
 */
export function ssoStatus(config: SsoConfigView): SsoStatus {
  const connection = config.connection;
  if (!connection) return 'not_set_up';
  if (connection.active) return 'active';
  return connection.idpConfigured ? 'off' : 'not_set_up';
}

/** The switch is on but Clerk is not sending anyone to the IdP: the entitlement lapsed. */
export function isPaused(config: SsoConfigView): boolean {
  const connection = config.connection;
  return Boolean(connection?.enabled && !connection.active);
}

// ============================================================================
// Add-on card
// ============================================================================

export type SsoAddonState =
  /** The plan includes SSO. */
  | { kind: 'included' }
  /** Staff granted it at no charge (custom price 0). */
  | { kind: 'free-grant' }
  /** The paid add-on is running. */
  | {
      kind: 'subscribed';
      /** A payment failed and Stripe is retrying; SSO keeps working. */
      pastDue: boolean;
      /** Retries are over: SSO is off until the open invoice is paid. */
      unpaid: boolean;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      /** The plan has since started to include SSO: the add-on is no longer needed. */
      includedInPlan: boolean;
    }
  /** It can be bought now; `hasPaymentMethod` says whether a card is on file. */
  | { kind: 'purchasable'; hasPaymentMethod: boolean }
  /** Free plan: upgrade first. */
  | { kind: 'free-plan' }
  /** Billed by a partner: the partner adds it. */
  | { kind: 'partner' }
  | { kind: 'unavailable' };

export function ssoAddonState(billing: SsoBillingView): SsoAddonState {
  const subscription = billing.subscription;
  if (subscription && subscription.status !== 'canceled') {
    return {
      kind: 'subscribed',
      pastDue: subscription.status === 'past_due',
      unpaid: subscription.status === 'unpaid',
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      includedInPlan: billing.unavailableReason === 'INCLUDED_IN_PLAN',
    };
  }

  switch (billing.unavailableReason) {
    case 'INCLUDED_IN_PLAN':
      return { kind: 'included' };
    case 'FREE_GRANT':
      return { kind: 'free-grant' };
    case 'FREE_PLAN':
      return { kind: 'free-plan' };
    case 'PARTNER_MANAGED':
      return { kind: 'partner' };
    case null:
      break;
  }

  if (billing.purchasable) return { kind: 'purchasable', hasPaymentMethod: billing.hasPaymentMethod };
  if (billing.entitlement.source === 'plan') return { kind: 'included' };
  if (billing.entitlement.source === 'free') return { kind: 'free-grant' };
  return { kind: 'unavailable' };
}

/** A date from the API in the UI language ("14 November 2026"), or '' when it is missing or unreadable. */
export function formatSsoDate(iso: string | null | undefined, language: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// ============================================================================
// Activation
// ============================================================================

export type ActivationBlock = 'not_entitled' | 'domain_unverified' | 'no_connection' | 'idp_incomplete';

/**
 * What stops SSO from being switched on, or null when nothing does. Switching
 * it off is never blocked.
 */
export function activationBlock(config: SsoConfigView): ActivationBlock | null {
  if (!config.entitlement.entitled) return 'not_entitled';
  if (!config.domain?.verified) return 'domain_unverified';
  if (!config.connection) return 'no_connection';
  if (!config.connection.idpConfigured) return 'idp_incomplete';
  return null;
}

// ============================================================================
// Domain
// ============================================================================

export type DomainIssue = 'required' | 'invalid' | 'public';

/** Why a typed domain would be refused, mirroring the server's checks. */
export function domainIssue(input: string): DomainIssue | null {
  if (!input.trim()) return 'required';
  const domain = normalizeSsoDomain(input);
  if (!domain) return 'invalid';
  if (isPublicEmailDomain(domain)) return 'public';
  return null;
}

// ============================================================================
// Identity provider form
// ============================================================================

/** How the identity provider's details are supplied. */
export type IdpMethod = 'url' | 'xml' | 'manual';

export interface IdpFormValues {
  provider: SsoProviderId;
  method: IdpMethod;
  metadataUrl: string;
  metadataXml: string;
  entityId: string;
  ssoUrl: string;
  certificate: string;
}

/** The method a saved connection was set up with; a fresh one starts on the recommended URL. */
export function idpMethodOf(idp: SsoIdp): IdpMethod {
  if (idp.metadataUrl) return 'url';
  if (idp.hasMetadata) return 'xml';
  if (idp.entityId || idp.ssoUrl || idp.hasCertificate) return 'manual';
  return 'url';
}

/**
 * The form's starting values. The metadata XML and the certificate are never
 * sent back by the API, so they start empty (a saved one is kept when left empty).
 */
export function idpFormValues(provider: SsoProviderId, idp: SsoIdp): IdpFormValues {
  return {
    provider,
    method: idpMethodOf(idp),
    metadataUrl: idp.metadataUrl ?? '',
    metadataXml: '',
    entityId: idp.entityId ?? '',
    ssoUrl: idp.ssoUrl ?? '',
    certificate: '',
  };
}

export type IdpField = 'metadataUrl' | 'metadataXml' | 'entityId' | 'ssoUrl' | 'certificate';
export type IdpIssueCode = 'required' | 'httpsUrl' | 'notXml';
export interface IdpIssue {
  field: IdpField;
  code: IdpIssueCode;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** What is wrong with the fields of the chosen method; fields of the other methods are ignored. */
export function idpIssues(values: IdpFormValues, idp: SsoIdp): IdpIssue[] {
  const issues: IdpIssue[] = [];
  const url = (field: 'metadataUrl' | 'ssoUrl') => {
    const value = values[field].trim();
    if (!value) issues.push({ field, code: 'required' });
    else if (!isHttpsUrl(value)) issues.push({ field, code: 'httpsUrl' });
  };

  switch (values.method) {
    case 'url':
      url('metadataUrl');
      break;
    case 'xml': {
      const xml = values.metadataXml.trim();
      if (!xml) {
        if (!idp.hasMetadata) issues.push({ field: 'metadataXml', code: 'required' });
      } else if (!xml.startsWith('<')) {
        issues.push({ field: 'metadataXml', code: 'notXml' });
      }
      break;
    }
    case 'manual':
      if (!values.entityId.trim()) issues.push({ field: 'entityId', code: 'required' });
      url('ssoUrl');
      if (!values.certificate.trim() && !idp.hasCertificate) issues.push({ field: 'certificate', code: 'required' });
      break;
  }
  return issues;
}

/**
 * The `PUT /api/sso/connection` body for the form. Only the chosen method's
 * fields are sent, and a stored value of another method is cleared (`null`)
 * so two sources never disagree. Metadata XML and the certificate left empty
 * keep what is stored.
 */
export function connectionInputFrom(values: IdpFormValues, idp: SsoIdp): SsoConnectionInput {
  const input: SsoConnectionInput = { provider: values.provider };

  switch (values.method) {
    case 'url':
      input.idpMetadataUrl = values.metadataUrl.trim();
      if (idp.hasMetadata) input.idpMetadata = null;
      break;
    case 'xml': {
      const xml = values.metadataXml.trim();
      if (xml) input.idpMetadata = xml;
      if (idp.metadataUrl) input.idpMetadataUrl = null;
      break;
    }
    case 'manual': {
      input.idpEntityId = values.entityId.trim();
      input.idpSsoUrl = values.ssoUrl.trim();
      const certificate = values.certificate.trim();
      if (certificate) input.idpCertificate = certificate;
      if (idp.metadataUrl) input.idpMetadataUrl = null;
      if (idp.hasMetadata) input.idpMetadata = null;
      break;
    }
  }
  return input;
}

// ============================================================================
// WeldID mode (Kubernetes editions): the OpenID Connect connection
// ============================================================================

export type SsoOidcConnection = NonNullable<SsoOidcView['connection']>;

/** The WeldID part of the view, when the backend answers in WeldID mode. */
export function oidcView(config: SsoConfigView): SsoOidcView | null {
  return config.mode === 'weldid' && config.oidc ? config.oidc : null;
}

/**
 * `active`: sign-ins at the verified domains go to the identity provider.
 * `off`: a connection exists but isn't doing that (switched off, or no
 * verified domain yet). `not_set_up`: no connection.
 */
export function oidcStatus(oidc: SsoOidcView): SsoStatus {
  if (!oidc.connection) return 'not_set_up';
  return oidc.active ? 'active' : 'off';
}

export type OidcActivationBlock = 'not_entitled' | 'no_connection' | 'domain_unverified';

/** What stops WeldID SSO from being switched on, or null. Switching off is never blocked. */
export function oidcActivationBlock(config: SsoConfigView, oidc: SsoOidcView): OidcActivationBlock | null {
  if (!config.entitlement.entitled) return 'not_entitled';
  if (!oidc.connection) return 'no_connection';
  if (!oidc.domains.some((domain) => domain.verified)) return 'domain_unverified';
  return null;
}

export interface OidcFormValues {
  displayName: string;
  issuer: string;
  clientId: string;
  /** Write-only: empty keeps a stored secret. */
  clientSecret: string;
  /** As typed: separated by spaces or commas. */
  scopes: string;
  trustEmails: boolean;
}

/** The form's starting values. The secret is never sent back, so it starts empty. */
export function oidcFormValues(connection: SsoOidcConnection | null): OidcFormValues {
  return {
    displayName: connection?.displayName ?? '',
    issuer: connection?.issuer ?? '',
    clientId: connection?.clientId ?? '',
    clientSecret: '',
    scopes: connection?.scopes.join(' ') ?? '',
    trustEmails: connection?.trustEmails ?? false,
  };
}

export type OidcField = Exclude<keyof OidcFormValues, 'trustEmails'>;
export type OidcIssueCode = 'required' | 'httpsUrl' | 'scopes';
export interface OidcIssue {
  field: OidcField;
  code: OidcIssueCode;
}

/** What is wrong with the form; a new connection needs a secret, a saved one keeps its own. */
export function oidcIssues(values: OidcFormValues, connection: SsoOidcConnection | null): OidcIssue[] {
  const issues: OidcIssue[] = [];
  if (!values.displayName.trim()) issues.push({ field: 'displayName', code: 'required' });
  const issuer = values.issuer.trim();
  if (!issuer) issues.push({ field: 'issuer', code: 'required' });
  else if (!isHttpsUrl(issuer)) issues.push({ field: 'issuer', code: 'httpsUrl' });
  if (!values.clientId.trim()) issues.push({ field: 'clientId', code: 'required' });
  if (!values.clientSecret.trim() && !connection?.hasClientSecret) {
    issues.push({ field: 'clientSecret', code: 'required' });
  }
  if (!areSsoScopesValid(parseSsoScopes(values.scopes))) issues.push({ field: 'scopes', code: 'scopes' });
  return issues;
}

/**
 * The `PUT /api/sso/connection` body for the form: everything for a new
 * connection, only what changed for a saved one. A secret left empty is not
 * sent, so the stored one stays.
 */
export function oidcInputFrom(values: OidcFormValues, connection: SsoOidcConnection | null): SsoOidcConnectionInput {
  const next = {
    displayName: values.displayName.trim(),
    issuer: values.issuer.trim(),
    clientId: values.clientId.trim(),
    scopes: parseSsoScopes(values.scopes),
    trustEmails: values.trustEmails,
  };
  const secret = values.clientSecret.trim();
  if (!connection) return { ...next, clientSecret: secret };

  const input: SsoOidcConnectionInput = {};
  if (next.displayName !== connection.displayName) input.displayName = next.displayName;
  if (next.issuer !== connection.issuer) input.issuer = next.issuer;
  if (next.clientId !== connection.clientId) input.clientId = next.clientId;
  if (next.scopes.join(' ') !== connection.scopes.join(' ')) input.scopes = next.scopes;
  if (next.trustEmails !== connection.trustEmails) input.trustEmails = next.trustEmails;
  if (secret) input.clientSecret = secret;
  return input;
}

/** The verified domains, for the sentence that names them ("acme.com, acme.nl"). */
export function verifiedDomainNames(oidc: SsoOidcView): string {
  return oidc.domains
    .filter((domain) => domain.verified)
    .map((domain) => domain.name)
    .join(', ');
}

// ============================================================================
// WeldID mode: a SAML connection
// ============================================================================

/** Where the form takes the identity provider's metadata from. */
export type SamlMetadataSource = 'url' | 'file';

export interface SamlFormValues {
  displayName: string;
  source: SamlMetadataSource;
  metadataUrl: string;
  /** The uploaded file's text; empty when none was chosen. */
  metadataXml: string;
  trustEmails: boolean;
}

/** A SAML connection's form, from what is saved (a new one trusts its IdP's emails: SAML has no flag for it). */
export function samlFormValues(connection: SsoOidcConnection | null): SamlFormValues {
  const metadataUrl = connection?.saml?.idpMetadataUrl ?? '';
  return {
    displayName: connection?.displayName ?? '',
    source: connection && !metadataUrl ? 'file' : 'url',
    metadataUrl,
    metadataXml: '',
    trustEmails: connection ? connection.trustEmails : true,
  };
}

export type SamlField = 'displayName' | 'metadataUrl' | 'metadataXml';
export type SamlIssueCode = 'required' | 'httpsUrl' | 'metadataRequired';

export interface SamlIssue {
  field: SamlField;
  code: SamlIssueCode;
}

/**
 * What is wrong with the form: a new connection needs its metadata; a saved
 * one keeps its own unless a URL is given or a file chosen.
 */
export function samlIssues(values: SamlFormValues, connection: SsoOidcConnection | null): SamlIssue[] {
  const issues: SamlIssue[] = [];
  if (!values.displayName.trim()) issues.push({ field: 'displayName', code: 'required' });
  if (values.source === 'url') {
    const url = values.metadataUrl.trim();
    if (url && !isHttpsUrl(url)) issues.push({ field: 'metadataUrl', code: 'httpsUrl' });
    else if (!url && !connection) issues.push({ field: 'metadataUrl', code: 'metadataRequired' });
  } else if (!values.metadataXml.trim() && !connection) {
    issues.push({ field: 'metadataXml', code: 'metadataRequired' });
  }
  return issues;
}

/**
 * The `PUT /api/sso/connection` body for the SAML form: everything for a new
 * connection; for a saved one what changed, and the metadata when a file was
 * chosen or a URL given (a URL is fetched again even when it is the same: how
 * a new signing certificate is picked up).
 */
export function samlInputFrom(values: SamlFormValues, connection: SsoOidcConnection | null): SsoOidcConnectionInput {
  const displayName = values.displayName.trim();
  const metadata: Pick<SsoOidcConnectionInput, 'metadataUrl' | 'metadataXml'> = {};
  if (values.source === 'url' && values.metadataUrl.trim()) metadata.metadataUrl = values.metadataUrl.trim();
  if (values.source === 'file' && values.metadataXml.trim()) metadata.metadataXml = values.metadataXml;
  if (!connection) {
    return { protocol: 'saml', displayName, trustEmails: values.trustEmails, ...metadata };
  }
  const input: SsoOidcConnectionInput = { ...metadata };
  if (displayName !== connection.displayName) input.displayName = displayName;
  if (values.trustEmails !== connection.trustEmails) input.trustEmails = values.trustEmails;
  return input;
}

/** Whether a saved connection is a SAML one (answers from before SAML have no protocol). */
export function isSamlConnection(connection: SsoOidcConnection | null): boolean {
  return connection?.protocol === 'saml';
}

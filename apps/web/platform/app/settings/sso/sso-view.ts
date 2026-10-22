/**
 * Pure rules of Settings > Single sign-on: what the status badge says, which
 * state the add-on card is in, whether SSO can be switched on, and how the
 * identity provider form maps to `PUT /api/sso/connection`. Kept out of the
 * components so they can be unit tested.
 */

import {
  isPublicEmailDomain,
  normalizeSsoDomain,
  type SsoBillingView,
  type SsoConfigView,
  type SsoConnectionInput,
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
      pastDue: boolean;
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

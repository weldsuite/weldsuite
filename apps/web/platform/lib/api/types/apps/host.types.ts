/**
 * Host Application Types
 * Domain and DNS management
 */

import { BaseEntity } from '../common.types';

export namespace Host {
  /**
   * Domain
   */
  export interface Domain extends BaseEntity {
    // Basic Information
    name: string;
    tld: string; // top-level domain
    fullDomain: string; // name + tld
    domain?: string; // Alternative field for full domain name

    // Status
    status: DomainStatus;
    registrationStatus?: RegistrationStatus;

    // Registrar
    registrar?: string;
    registrarId?: string;

    // Dates
    registeredAt?: Date;
    expiresAt?: Date;
    renewedAt?: Date;
    transferredAt?: Date;

    // Renewal
    autoRenew?: boolean;
    renewalPrice?: number;
    currency?: string;

    // Nameservers
    nameservers?: string[];
    customNameservers?: boolean;

    // DNS
    dnsProvider?: string;
    dnsRecordCount?: number;

    // Contact
    registrantContact?: DomainContact;
    adminContact?: DomainContact;
    techContact?: DomainContact;
    billingContact?: DomainContact;

    // Privacy
    privacyProtection?: boolean;
    whoisPrivacy?: boolean;

    // Transfer
    transferLock?: boolean;
    authCode?: string; // EPP code

    // Services
    emailForwardingEnabled?: boolean;
    redirectEnabled?: boolean;
    redirectUrl?: string;

    // Security & SSL
    sslEnabled?: boolean;
    locked?: boolean;
    verified?: boolean;

    // Nameserver Verification
    nameserverVerified?: boolean;
    nameserverVerificationPending?: boolean;

    // Metadata
    tags?: string[];
    notes?: string;
  }

  /**
   * DNS Record
   */
  export interface DnsRecord extends BaseEntity {
    domainId: string;
    domainName?: string;

    // Record Details
    type: DnsRecordType;
    name: string; // subdomain or @
    value: string; // target value
    ttl: number; // time to live in seconds

    // Optional Fields
    priority?: number; // for MX records
    weight?: number; // for SRV records
    port?: number; // for SRV records

    // Status
    status: RecordStatus;

    // Proxy (for CDN)
    proxied?: boolean;

    // Metadata
    description?: string;
    tags?: string[];
  }

  /**
   * Email Forward
   */
  export interface EmailForward extends BaseEntity {
    domainId: string;
    domainName?: string;

    // Forward Details
    source: string; // email@domain.com
    destination: string; // target email

    // Status
    enabled: boolean;
    status: ForwardStatus;

    // Options
    catchAll?: boolean;
    wildcard?: boolean;

    // Metadata
    description?: string;
    tags?: string[];
  }

  /**
   * Domain Transfer
   */
  export interface DomainTransfer extends BaseEntity {
    domainId: string;
    domainName: string;

    // Transfer Details
    type: TransferType;
    status: TransferStatus;
    authCode?: string;

    // Parties
    fromRegistrar?: string;
    toRegistrar?: string;

    // Dates
    requestedAt: Date;
    approvedAt?: Date;
    completedAt?: Date;
    cancelledAt?: Date;

    // Notes
    notes?: string;
  }

  /**
   * WHOIS Record
   */
  export interface WhoisRecord extends BaseEntity {
    domainId: string;
    domainName: string;

    // Registrant
    registrant: DomainContact;
    admin: DomainContact;
    tech: DomainContact;
    billing?: DomainContact;

    // Dates
    createdDate: Date;
    updatedDate: Date;
    expiryDate: Date;

    // Nameservers
    nameservers: string[];

    // Status
    domainStatus: string[];

    // Registrar
    registrar: string;
    registrarUrl?: string;
    registrarIanaId?: string;

    // Privacy
    privacyService?: boolean;

    // Raw Data
    rawWhoisData?: string;

    // Last Updated
    lastChecked: Date;
  }

  /**
   * DNS Zone
   */
  export interface DnsZone extends BaseEntity {
    domainId: string;
    domainName: string;

    // Zone Details
    zoneName: string;
    type: ZoneType;

    // SOA Record
    primaryNameserver: string;
    adminEmail: string;
    serialNumber: number;
    refreshInterval: number;
    retryInterval: number;
    expireTime: number;
    minimumTtl: number;

    // Status
    status: ZoneStatus;

    // Records
    recordCount: number;

    // DNSSEC
    dnssecEnabled?: boolean;
    dnssecStatus?: DnssecStatus;

    // Metadata
    lastModified: Date;
    tags?: string[];
  }

  /**
   * Nameserver Verification
   */
  export interface NameserverVerification {
    verified: boolean;
    requiredNameservers: string[];
    currentNameservers: string[];
    verifiedAt?: Date;
    lastChecked?: Date;
    message: string;
  }

  // ==========================================
  // Supporting Types
  // ==========================================

  export interface DomainContact {
    firstName: string;
    lastName: string;
    organization?: string;
    email: string;
    phone: string;
    address: Address;
  }

  // ==========================================
  // Enums
  // ==========================================

  // ==========================================
  // Dashboard Types
  // ==========================================

  /**
   * Dashboard statistics response
   */
  export interface DashboardStatistics {
    domainsExpiringSoon: number;
    sslCertificatesToRenew: number;
    dnsConfigurationAlerts: number;
    activeDomains: number;
  }

  /**
   * Chart data point for dashboard analytics - domain registrations and renewals
   */
  /**
   * Chart data response - domain registrations and renewals over time
   */
  export interface ChartData {
    data: ChartDataPoint[];
    totalRegistered: number;  // Total domain registrations
    totalRenewed: number;      // Total domain renewals
  }

  /**
   * Simplified domain for dashboard recent domains
   */
  export interface DashboardDomain {
    id: string;
    name: string;
    status: string;
    type: string;
    createdAt: Date;
    formattedDate: string;
  }

  /**
   * Domain pricing information
   */
  export interface DomainPricing {
    tld: string;
    tldDisplayName?: string;
    category?: string;
    registrationPrice: number;
    renewalPrice: number;
    transferPrice: number;
    restorePrice?: number;
    privacyProtectionPrice?: number;
    currency: string;
    hasActivePromotion: boolean;
    minRegistrationYears: number;
    maxRegistrationYears: number;
    isPopular: boolean;
    isPremium: boolean;
    supportsPrivacyProtection: boolean;
  }

  /**
   * Domain checkout item for purchase
   */
  export interface DomainCheckoutItem {
    domainName: string;
    autoRenew?: boolean;
    years?: number;
    privacyProtection?: boolean;
  }

  /**
   * Domain purchase checkout response
   */
  export interface DomainPurchaseCheckoutResponse {
    registrationIds: string[];
    checkoutSessionId: string;
    checkoutUrl: string;
  }

  /**
   * Domain purchase status response
   */
  export interface DomainPurchaseStatusResponse {
    registrationId: string;
    domainName: string;
    status: string;
    totalPrice: number;
    errorMessage?: string;
    registeredAt?: string;
    expiresAt?: string;
    domainId?: string;
  }
}

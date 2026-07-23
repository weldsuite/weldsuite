/**
 * Sites Application Types
 * Website builder and hosting platform
 */

import { BaseEntity, File } from '../common.types';

export namespace Sites {
  /**
   * Site - Website instance
   */
  export interface Site extends BaseEntity {
    // Basic Information
    name: string;
    domain: string;
    subdomain?: string;
    customDomains?: string[];

    // Type & Template
    type: SiteType;
    template?: string;
    templateId?: string;
    theme?: string;

    // Content
    pages?: Page[];
    posts?: BlogPost[];
    menus?: Menu[];

    // SEO
    title?: string;
    description?: string;
    keywords?: string[];
    favicon?: string;
    ogImage?: string;

    // Status
    status: SiteStatus;
    publishedAt?: Date;
    lastDeployedAt?: Date;
    deploymentStatus?: DeploymentStatus;

    // Settings
    settings?: SiteSettings;
    analytics?: AnalyticsConfig;
    integrations?: Integration[];

    // SSL
    sslEnabled: boolean;
    sslCertificate?: SSLCertificate;

    // Performance
    cdn?: CDNConfig;
    caching?: CacheConfig;

    // Access
    isPublic: boolean;
    password?: string;
    allowedIps?: string[];

    // Metadata
    tags?: string[];
    customFields?: Record<string, any>;
  }

  /**
   * Page - Website page
   */
  export interface Page extends BaseEntity {
    siteId: string;

    // Basic Info
    title: string;
    slug: string;
    path?: string;

    // Content
    content?: string;
    blocks?: Block[];
    sections?: Section[];

    // Layout
    layout?: string;
    template?: string;

    // SEO
    metaTitle?: string;
    metaDescription?: string;
    metaKeywords?: string[];
    canonicalUrl?: string;
    robots?: string;

    // Status
    status: PageStatus;
    publishedAt?: Date;
    scheduledPublishAt?: Date;

    // Hierarchy
    parentId?: string;
    order?: number;

    // Settings
    showInMenu?: boolean;
    showInSitemap?: boolean;
    isHomepage?: boolean;
    requires404?: boolean;

    // Custom Code
    customCss?: string;
    customJs?: string;
    headerCode?: string;
    footerCode?: string;
  }

  /**
   * Block - Page content block
   */
  /**
   * Section - Page section container
   */
  /**
   * Blog Post
   */
  /**
   * Menu - Navigation menu
   */
  /**
   * Form - Contact/custom forms
   */
  export interface Form extends BaseEntity {
    siteId: string;
    name: string;

    // Fields
    fields: FormField[];

    // Settings
    submitButton?: string;
    successMessage?: string;
    errorMessage?: string;
    redirectUrl?: string;

    // Notifications
    emailTo?: string[];
    emailSubject?: string;
    emailTemplate?: string;

    // Integration
    webhook?: string;
    integrations?: FormIntegration[];

    // Anti-spam
    captchaEnabled?: boolean;
    honeypotEnabled?: boolean;

    // Submissions
    submissionCount?: number;
    lastSubmissionAt?: Date;
  }

  /**
   * Media/Asset
   */
  /**
   * Domain - Custom domain configuration
   */
  export interface Domain extends BaseEntity {
    siteId: string;
    domain: string;

    // DNS
    dnsStatus: DNSStatus;
    dnsRecords?: DNSRecord[];
    verificationCode?: string;
    verifiedAt?: Date;

    // SSL
    sslStatus: SSLStatus;
    sslProvider?: string;
    sslExpiresAt?: Date;

    // Status
    isActive: boolean;
    isPrimary: boolean;

    // Redirects
    redirectTo?: string;
    redirectType?: number; // 301, 302
  }

  // ==========================================
  // Supporting Types
  // ==========================================

  // ==========================================
  // Enums
  // ==========================================

  }
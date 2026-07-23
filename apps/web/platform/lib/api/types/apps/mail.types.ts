/**
 * Mail Application Types
 * Email management and communication
 */

import { BaseEntity, Attachment } from '../common.types';

export namespace Mail {
  /**
   * Email Account
   */
  export interface EmailAccount extends BaseEntity {
    // Account Information
    name: string;
    email: string;
    displayName?: string;

    // Provider
    provider: EmailProvider;
    providerConfig?: ProviderConfig;

    // Authentication
    authType: 'oauth2' | 'password' | 'api_key';
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;

    // Server Settings (for IMAP/SMTP)
    imapHost?: string;
    imapPort?: number;
    imapSecure?: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;

    // Sync Settings
    syncEnabled: boolean;
    syncFrequency?: number; // minutes
    lastSyncAt?: Date;
    syncStatus?: SyncStatus;
    syncError?: string;

    // Folders
    folders?: EmailFolder[];
    defaultFolderId?: string;

    // Settings
    signature?: string;
    autoReply?: AutoReply;
    forwardingEmail?: string;

    // Limits
    dailySendLimit?: number;
    sentToday?: number;
    storageUsed?: number;
    storageLimit?: number;

    // Status
    status: AccountStatus;
    isDefault?: boolean;
    isShared?: boolean;

    // Metadata
    tags?: string[];
    customFields?: Record<string, any>;
  }

  /**
   * Email Message
   */
  export interface Email extends Omit<BaseEntity, 'createdAt' | 'updatedAt'> {
    // Timestamps (optional for UI display)
    createdAt?: Date;
    updatedAt?: Date;

    // Account
    accountId?: string;
    folderId?: string;

    // Message ID
    messageId?: string;
    threadId?: string;
    conversationId?: string;

    // Headers
    from: string | EmailAddress;
    fromEmail?: string; // Convenience: just the email string
    fromName?: string; // Convenience: just the name string
    to: string[] | EmailAddress[];
    cc?: string[] | EmailAddress[];
    bcc?: string[] | EmailAddress[];
    replyTo?: EmailAddress;

    // Content
    subject: string;
    preview?: string;
    textBody?: string;
    htmlBody?: string;
    bodyText?: string; // Alias for textBody
    bodyHtml?: string; // Alias for htmlBody
    rawMessage?: string;

    // Dates
    sentDate?: Date;
    receivedDate?: Date;
    date?: Date; // Convenience: primary display date

    // Flags
    isRead: boolean;
    isStarred: boolean;
    isFlagged?: boolean;
    isImportant: boolean;
    isDraft: boolean;
    isSpam?: boolean;
    isTrash?: boolean;
    isDeleted?: boolean; // Alias for isTrash

    // Attachments
    hasAttachments: boolean;
    attachments?: EmailAttachment[];

    // UI Display
    folder?: string; // Folder name for display
    size?: number; // Message size

    // Threading
    inReplyTo?: string;
    references?: string[];
    isReply?: boolean;
    isForwarded?: boolean;

    // Labels & Categories
    labels?: string[];
    categories?: string[];

    // Priority
    priority?: EmailPriority;

    // Tracking
    readReceipt?: boolean;
    deliveryReceipt?: boolean;
    openedAt?: Date;
    clickedLinks?: ClickedLink[];

    // Security
    isEncrypted?: boolean;
    isSigned?: boolean;
    spfStatus?: SecurityStatus;
    dkimStatus?: SecurityStatus;
    dmarcStatus?: SecurityStatus;

    // Source
    source?: 'inbox' | 'sent' | 'composed';

    // Scheduling
    scheduledFor?: string | Date | null;
    sendStatus?: 'scheduled' | 'sent' | 'cancelled' | null;

    // Metadata
    headers?: Record<string, string>;
    customFields?: Record<string, any>;
  }

  /**
   * Email Folder
   */
  /**
   * Email Template
   */
  /**
   * Email Campaign
   */
  /**
   * Mail Rule/Filter
   */
  /**
   * Email Signature
   */
  /**
   * Contact (Email specific)
   */
  /**
   * Mail Domain
   */
  /**
   * DNS Record for email configuration
   */
  /**
   * Mail Domain with full details
   */
  /**
   * DNS Verification Result
   */
  /**
   * Enable Email for Domain Result
   */
  // ==========================================
  // Supporting Types
  // ==========================================

  // ==========================================
  // Enums
  // ==========================================

  /**
   * Email Draft
   */
  /**
   * Email Label
   */
  export interface Label {
    id?: string;
    name: string;
    count: number;
    color?: string;
    // AI Auto-Labeling
    aiEnabled?: boolean;
    aiKeywords?: string[];
    aiDescription?: string | null;
    aiConfidence?: number; // Minimum confidence threshold (0-100), default 70
  }

  /**
   * Email Attachment (extends base Attachment)
   */
  // MailDomain is defined earlier in this file (lines 362-371)

  /**
   * Send Email Request
   */
  /**
   * Send Email Response
   */
  }
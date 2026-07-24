/**
 * Helpdesk Application Types
 * Customer support and ticket management
 */

import { BaseEntity, Attachment } from '../common.types';

// The `Helpdesk.X` / `Helpdesk.Api.X` dot-access pattern below is consumed
// across many files outside this module's scope (app/welddesk, hooks/queries,
// hooks/helpdesk); converting away from namespaces would require updating
// every call site.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Helpdesk {
  /**
   * Conversation - Customer conversation/thread
   */
  export interface Conversation extends BaseEntity {
    // Identification
    conversationNumber: string;
    reference?: string;

    // Customer Information
    contactId?: string;
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
    customerCompany?: string;
    customerAvatar?: string;
    customerAvatarUrl?: string;

    // Conversation Details
    subject: string;
    preview: string;
    lastMessage?: string;

    // Status & Priority
    status: ConversationStatus;
    priority?: TicketPriority;

    // Assignment
    assigneeId?: string;
    assigneeName?: string;
    departmentId?: string;

    // Channel
    channel: TicketChannel;
    source?: string;
    metadata?: { website?: string; [key: string]: unknown };
    visitorLocation?: { country?: string; city?: string; region?: string; timezone?: string };

    // Messages
    messages?: ConversationMessage[];
    messageCount: number;
    unreadCount?: number;
    lastMessageAt: Date;
    lastCustomerMessageAt?: Date;
    lastAgentMessageAt?: Date;

    // Related
    ticketId?: string;
    relatedConversationIds?: string[];

    // Flags
    isRead: boolean;
    isStarred: boolean;
    isArchived: boolean;
    isSpam?: boolean;

    // Tags & Labels
    tags?: string[];
    labels?: string[];

    // Attachments
    hasAttachments: boolean;
    attachmentCount?: number;
  }

  /**
   * Conversation Message
   */
  export interface ConversationMessage extends BaseEntity {
    conversationId: string;

    // Author
    authorId?: string;
    authorName: string;
    authorEmail?: string;
    authorType: 'customer' | 'agent' | 'system';
    authorAvatar?: string;

    // Content
    content: string;
    htmlContent?: string;
    plainContent?: string;

    // Type & Visibility
    type: 'message' | 'note' | 'system';
    isPublic: boolean;
    isInternal?: boolean;

    // Status
    status?: 'sent' | 'delivered' | 'read' | 'failed';
    isRead: boolean;
    readAt?: Date;

    // Attachments
    attachments?: Attachment[];
    hasAttachments?: boolean;

    // Metadata
    metadata?: Record<string, unknown>;
  }

  /**
   * Ticket - Support request
   */
  export interface Ticket extends BaseEntity {
    // Identification
    ticketNumber: string;
    reference?: string;

    // Customer Information
    contactId?: string;
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
    customerCompany?: string;

    // Ticket Details
    subject: string;
    description: string;
    category: TicketCategory;
    subcategory?: string;

    // Status & Priority
    status: TicketStatus;
    priority: TicketPriority;
    severity?: TicketSeverity;

    // Assignment
    assigneeId?: string;
    assigneeName?: string;
    departmentId?: string;
    teamId?: string;

    // Channel
    channel: TicketChannel;
    sourceEmail?: string;
    sourceUrl?: string;

    // Type
    type: TicketType;
    issueType?: string;

    // SLA
    slaId?: string;
    responseDeadline?: Date;
    resolutionDeadline?: Date;
    slaStatus?: SLAStatus;
    breachedAt?: Date;

    // Timing
    firstResponseAt?: Date;
    resolvedAt?: Date;
    closedAt?: Date;
    reopenedAt?: Date;
    responseTime?: number; // minutes
    resolutionTime?: number; // minutes

    // Product/Service
    productId?: string;
    productName?: string;
    version?: number;
    environment?: string;

    // Messages
    messages?: TicketMessage[];
    messageCount?: number;
    lastMessageAt?: Date;
    lastCustomerMessageAt?: Date;
    lastAgentMessageAt?: Date;

    // Satisfaction
    satisfactionRating?: number;
    satisfactionComment?: string;
    satisfactionSurveyId?: string;

    // Internal
    internalNotes?: TicketNote[];
    tags?: string[];
    customFields?: Record<string, unknown>;

    // Related
    parentTicketId?: string;
    childTicketIds?: string[];
    relatedTicketIds?: string[];
    mergedTicketIds?: string[];

    // Flags
    isEscalated?: boolean;
    isSpam?: boolean;
    isPublic?: boolean;
    requiresApproval?: boolean;

    // Attachments
    attachments?: Attachment[];
    attachmentCount?: number;
  }

  /**
   * Ticket Message/Reply
   */
  export interface TicketMessage extends BaseEntity {
    ticketId: string;

    // Author
    authorId?: string;
    authorName: string;
    authorEmail: string;
    authorType: 'customer' | 'agent' | 'system';

    // Content
    subject?: string;
    body: string;
    htmlBody?: string;
    plainBody?: string;

    // Type
    type: MessageType;
    isPublic: boolean;
    isInternal?: boolean;

    // Status
    status?: 'sent' | 'delivered' | 'read' | 'failed';
    readAt?: Date;

    // Email Details
    messageId?: string;
    inReplyTo?: string;
    cc?: string[];
    bcc?: string[];

    // Attachments
    attachments?: Attachment[];

    // Metadata
    metadata?: Record<string, unknown>;
  }

  /**
   * Ticket Note - Internal notes
   */
  export interface TicketNote extends BaseEntity {
    ticketId: string;
    authorId: string;
    authorName: string;
    content: string;
    isImportant?: boolean;
    attachments?: Attachment[];
  }

  /**
   * Knowledge Base Article
   */
  export interface Article extends BaseEntity {
    // Basic Information
    title: string;
    slug: string;
    content: string;
    excerpt?: string;

    // Categorization
    category?: string; // Backend field name for category/folder path
    categoryId: string;
    categoryName?: string;
    subcategoryId?: string;
    sectionId?: string;

    // SEO
    metaTitle?: string;
    metaDescription?: string;
    keywords?: string[];

    // Author
    authorId: string;
    authorName?: string;
    reviewerId?: string;

    // Status
    status: ArticleStatus;
    visibility: ArticleVisibility;

    // Publishing
    publishedAt?: Date;
    unpublishedAt?: Date;
    scheduledPublishAt?: Date;

    // Versioning
    version?: number;
    isDraft?: boolean;
    previousVersionId?: string;

    // Content
    tableOfContents?: string;
    readTime?: number; // minutes
    difficulty?: 'beginner' | 'intermediate' | 'advanced';

    // Media
    featuredImage?: string;
    attachments?: Attachment[];
    videos?: string[];

    // Engagement
    viewCount?: number;
    likeCount?: number;
    dislikeCount?: number;
    helpfulCount?: number;
    notHelpfulCount?: number;

    // Related
    relatedArticles?: string[];
    relatedProducts?: string[];
    relatedTickets?: string[];

    // Tags
    tags?: string[];
    customFields?: Record<string, unknown>;

    // Flags
    isPinned?: boolean;
    allowComments?: boolean;
    requiresLogin?: boolean;
  }

  /**
   * Article Folder - hierarchical grouping for knowledge base articles.
   * The API returns a flat list (rows carry `parentId`); callers nest the
   * `children` array client-side when building a tree.
   */
  export interface ArticleFolder {
    id: string;
    name: string;
    slug?: string | null;
    description?: string | null;
    parentId?: string | null;
    path?: string | null;
    level: number;
    sortOrder: number;
    icon?: string | null;
    color?: string | null;
    articleCount: number;
    createdAt: Date;
    updatedAt: Date;
    children?: ArticleFolder[];
  }

  /**
   * FAQ - Frequently Asked Question
   */
  export interface FAQ extends BaseEntity {
    question: string;
    answer: string;
    category?: string;
    order?: number;

    // Visibility
    isPublished: boolean;
    publishedAt?: Date;

    // Engagement
    viewCount?: number;
    helpfulCount?: number;
    notHelpfulCount?: number;

    // Related
    relatedFAQs?: string[];
    relatedArticles?: string[];

    // Tags
    tags?: string[];
  }

  /**
   * Agent - Support agent
   */
  export interface Agent extends BaseEntity {
    // User Information
    userId: string;
    name: string;
    email: string;
    avatar?: string;

    // Role & Department
    role: AgentRole;
    departmentId?: string;
    teamIds?: string[];

    // Status
    status: AgentStatus;
    availability?: AgentAvailability;
    isOnline?: boolean;
    lastSeenAt?: Date;

    // Capacity
    maxActiveTickets?: number;
    currentActiveTickets?: number;

    // Skills
    skills?: string[];
    languages?: string[];
    expertise?: string[];

    // Permissions
    permissions?: AgentPermission[];
    canAccessAllTickets?: boolean;
    canManageKnowledge?: boolean;

    // Performance
    averageResponseTime?: number;
    averageResolutionTime?: number;
    satisfactionScore?: number;
    ticketsResolved?: number;
    ticketsAssigned?: number;

    // Working Hours
    workingHours?: WorkingHours;
    timezone?: string;

    // Signature
    signature?: string;

    // Notifications
    notificationPreferences?: NotificationPreferences;
  }

  /**
   * Department
   */
  export interface Department extends BaseEntity {
    name: string;
    description?: string;
    email?: string;

    // Manager
    managerId?: string;
    managerName?: string;

    // Team
    agentIds?: string[];
    agentCount?: number;

    // Settings
    autoAssignment?: boolean;
    roundRobinAssignment?: boolean;
    escalationRules?: EscalationRule[];

    // Business Hours
    businessHours?: BusinessHours;

    // Categories
    categories?: string[];
    defaultPriority?: TicketPriority;

    // Status
    isActive: boolean;
  }

  /**
   * SLA - Service Level Agreement
   */
  export interface SLA extends BaseEntity {
    name: string;
    description?: string;

    // Conditions
    conditions: SLACondition[];
    isDefault?: boolean;

    // Targets
    firstResponseTime: SLATarget;
    resolutionTime: SLATarget;
    updateTime?: SLATarget;

    // Business Hours
    operationalHours: 'business' | '24x7' | 'custom';
    businessHours?: BusinessHours;

    // Escalation
    escalationRules?: EscalationRule[];

    // Status
    isActive: boolean;
    priority?: number;

    // Reminders
    reminders?: SLAReminder[];
  }

  /**
   * Canned Response/Macro
   */
  export interface CannedResponse extends BaseEntity {
    name: string;
    subject?: string;
    content: string;
    category?: string;

    // Availability
    scope: 'personal' | 'team' | 'department' | 'global';
    agentId?: string;
    teamId?: string;
    departmentId?: string;

    // Usage
    usageCount?: number;
    lastUsedAt?: Date;

    // Shortcuts
    shortcut?: string;
    keywords?: string[];

    // Actions
    actions?: MacroAction[];

    // Status
    isActive: boolean;
  }

  /**
   * Customer Satisfaction Survey
   */
  export interface SatisfactionSurvey extends BaseEntity {
    ticketId: string;
    contactId: string;

    // Rating
    rating: number; // 1-5 or 1-10
    comment?: string;

    // Questions
    responses?: SurveyResponse[];

    // Timing
    sentAt: Date;
    respondedAt?: Date;
    expiresAt?: Date;

    // Status
    status: 'pending' | 'completed' | 'expired';

    // Follow-up
    followUpRequired?: boolean;
    followUpNotes?: string;
  }

  // ==========================================
  // Supporting Types
  // ==========================================

  interface DayHours {
    isOpen: boolean;
    openTime: string; // "09:00"
    closeTime: string; // "17:00"
  }

  export type WorkingHours = Record<
    'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
    DayHours
  >;

  export type BusinessHours = WorkingHours;

  export interface NotificationPreferences {
    email?: boolean;
    push?: boolean;
    sms?: boolean;
    inApp?: boolean;
  }

  export interface EscalationRule {
    id: string;
    condition: string;
    afterMinutes: number;
    action: 'notify' | 'reassign' | 'escalate_priority';
    notifyUserIds?: string[];
  }

  export interface SLACondition {
    field: string;
    operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than';
    value: string;
  }

  export interface SLATarget {
    minutes: number;
    businessHoursOnly?: boolean;
  }

  export interface SLAReminder {
    beforeMinutes: number;
    notifyUserIds?: string[];
    message?: string;
  }

  export interface MacroAction {
    type: 'set_status' | 'set_priority' | 'assign' | 'add_tag' | 'send_email';
    value?: string;
  }

  export interface SurveyResponse {
    questionId: string;
    question: string;
    answer: string | number;
  }

  export interface AiMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: Date;
  }

  // ==========================================
  // Enums
  // ==========================================

  export type TicketChannel =
    | 'email'
    | 'chat'
    | 'phone'
    | 'web_form'
    | 'social'
    | 'api'
    | 'whatsapp'
    | 'sms';

  export type TicketCategory =
    | 'general'
    | 'technical'
    | 'billing'
    | 'account'
    | 'feature_request'
    | 'bug'
    | 'other';

  export type TicketSeverity = 'low' | 'medium' | 'high' | 'critical';

  export type TicketType = 'question' | 'incident' | 'problem' | 'task' | 'feature_request';

  export type SLAStatus = 'on_track' | 'at_risk' | 'breached' | 'met';

  export type MessageType = 'reply' | 'note' | 'system' | 'forward';

  export type ArticleStatus = 'draft' | 'published' | 'archived';

  export type ArticleVisibility = 'public' | 'internal' | 'restricted';

  export type AgentRole = 'agent' | 'senior_agent' | 'team_lead' | 'admin';

  export type AgentStatus = 'active' | 'inactive' | 'on_leave';

  export type AgentPermission = string;

  export type ConversationStatus =
    | 'active'
    | 'pending'
    | 'resolved'
    | 'closed'
    | 'archived'
    | 'snoozed';

  export type TicketStatus =
    | 'new'
    | 'open'
    | 'pending'
    | 'on_hold'
    | 'in_progress'
    | 'resolved'
    | 'closed'
    | 'cancelled';

  export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent' | 'critical';
  export type AgentAvailability =
    | 'available'
    | 'busy'
    | 'away'
    | 'offline';

  // ==========================================
  // API Request/Response Contracts
  // ==========================================

  /**
   * Namespace for API-specific types (requests/responses)
   */
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Api {
    // Dashboard & Statistics
    export interface DashboardStats {
      tickets: {
        total: number;
        open: number;
        inProgress: number;
        pending: number;
        resolved: number;
        closed: number;
        avgResponseTime: number; // minutes
        avgResolutionTime: number; // minutes
      };
      satisfaction: {
        avgRating: number; // 1-5
        totalResponses: number;
        lastWeekRating: number;
      };
      agents: {
        total: number;
        available: number;
        busy: number;
        away: number;
        offline: number;
      };
      recentActivity: {
        timestamp: Date;
        type: 'ticket_created' | 'ticket_resolved' | 'message_received';
        description: string;
      }[];
    }

    export interface TicketStats {
      totalTickets: number;
      openTickets: number;
      inProgressTickets: number;
      resolvedTickets: number;
      closedTickets: number;
      byPriority: Record<string, number>;
      byCategory: Record<string, number>;
      byStatus: Record<string, number>;
      bySource: Record<string, number>;
      trend: {
        date: string;
        opened: number;
        resolved: number;
      }[];
    }

    export interface AgentPerformance {
      agentId: string;
      agentName: string;
      period: {
        startDate: string;
        endDate: string;
      };
      metrics: {
        ticketsHandled: number;
        ticketsResolved: number;
        avgResponseTime: number; // minutes
        avgResolutionTime: number; // minutes
        satisfactionScore: number; // 1-5
        firstContactResolution: number; // percentage
      };
    }

    // Contacts
    export interface Contact {
      id: string;
      name: string;
      email: string;
      phone?: string;
      company?: string;
      role?: string;
      avatar?: string;
      tags?: string[];
      customFields?: Record<string, unknown>;
      totalTickets?: number;
      lastContactDate?: Date;
      createdAt: Date;
      updatedAt: Date;
    }

    export interface CreateContactRequest {
      name: string;
      email: string;
      phone?: string;
      company?: string;
      role?: string;
      tags?: string[];
      customFields?: Record<string, unknown>;
    }

    export interface UpdateContactRequest {
      name?: string;
      email?: string;
      phone?: string;
      company?: string;
      role?: string;
      tags?: string[];
      customFields?: Record<string, unknown>;
    }

    // Customers (with helpdesk-specific data)
    export interface HelpdeskCustomer {
      id: string;
      name: string;
      firstName?: string;
      lastName?: string;
      email: string;
      phone?: string;
      company?: string;
      customerGroup?: string;
      vipStatus?: string;
      accountStatus?: string;
      status: 'active' | 'inactive' | 'vip';
      tags: string[];
      totalSpent: number;
      orderCount: number;
      loyaltyPoints?: number;
      loyaltyTier?: string;
      conversationCount: number;
      lastConversationDate?: Date;
      createdAt: Date;
      updatedAt?: Date;
    }

    export interface CustomerConversation {
      id: string;
      subject?: string;
      status: string;
      channel: string;
      createdAt: Date;
      updatedAt?: Date;
      closedAt?: Date;
    }

    // Announcements
    export interface Announcement {
      id: string;
      title: string;
      content: string;
      excerpt?: string;
      type: 'info' | 'warning' | 'success' | 'error';
      status: 'draft' | 'published' | 'archived';
      visibility: 'public' | 'internal' | 'specific_groups';
      targetGroups?: string[];
      featuredImage?: string;
      authorId: string;
      authorName?: string;
      publishedAt?: Date;
      expiresAt?: Date;
      isPinned?: boolean;
      viewCount?: number;
      createdAt: Date;
      updatedAt: Date;
    }

    export interface CreateAnnouncementRequest {
      title: string;
      content: string;
      excerpt?: string;
      type: 'info' | 'warning' | 'success' | 'error';
      visibility?: 'public' | 'internal' | 'specific_groups';
      targetGroups?: string[];
      featuredImage?: string;
      publishedAt?: Date;
      expiresAt?: Date;
      isPinned?: boolean;
    }

    export interface UpdateAnnouncementRequest extends Partial<CreateAnnouncementRequest> {
      status?: 'draft' | 'published' | 'archived';
    }

    // Changelog
    export interface ChangelogEntry {
      id: string;
      version: string;
      title: string;
      description: string;
      releaseDate: Date;
      status: 'draft' | 'published';
      type: 'feature' | 'improvement' | 'bugfix' | 'security' | 'breaking';
      changes: {
        id: string;
        type: 'feature' | 'improvement' | 'bugfix' | 'security' | 'breaking';
        description: string;
        issueNumber?: string;
      }[];
      authorId: string;
      authorName?: string;
      createdAt: Date;
      updatedAt: Date;
    }

    export interface CreateChangelogEntryRequest {
      version: string;
      title: string;
      description: string;
      releaseDate: Date;
      type: 'feature' | 'improvement' | 'bugfix' | 'security' | 'breaking';
      changes: {
        type: 'feature' | 'improvement' | 'bugfix' | 'security' | 'breaking';
        description: string;
        issueNumber?: string;
      }[];
    }

    export interface UpdateChangelogEntryRequest extends Partial<CreateChangelogEntryRequest> {
      status?: 'draft' | 'published';
    }

    // Events
    export interface Event {
      id: string;
      title: string;
      description: string;
      type: 'webinar' | 'maintenance' | 'training' | 'announcement' | 'other';
      status: 'scheduled' | 'ongoing' | 'completed' | 'cancelled';
      startDate: Date;
      endDate: Date;
      location?: string;
      isOnline: boolean;
      meetingLink?: string;
      maxAttendees?: number;
      currentAttendees?: number;
      registrationRequired: boolean;
      registrationDeadline?: Date;
      organizerId: string;
      organizerName?: string;
      attendees?: {
        userId: string;
        userName: string;
        email: string;
        registeredAt: Date;
      }[];
      reminders?: {
        sentAt: Date;
        type: 'email' | 'push';
      }[];
      createdAt: Date;
      updatedAt: Date;
    }

    export interface CreateEventRequest {
      title: string;
      description: string;
      type: 'webinar' | 'maintenance' | 'training' | 'announcement' | 'other';
      startDate: Date;
      endDate: Date;
      location?: string;
      isOnline: boolean;
      meetingLink?: string;
      maxAttendees?: number;
      registrationRequired: boolean;
      registrationDeadline?: Date;
    }

    export interface UpdateEventRequest extends Partial<CreateEventRequest> {
      status?: 'scheduled' | 'ongoing' | 'completed' | 'cancelled';
    }

    // News
    export interface NewsItem {
      id: string;
      title: string;
      content: string;
      excerpt?: string;
      category: string;
      tags?: string[];
      status: 'draft' | 'published' | 'archived';
      featuredImage?: string;
      authorId: string;
      authorName?: string;
      publishedAt?: Date;
      viewCount?: number;
      likeCount?: number;
      commentCount?: number;
      isPinned?: boolean;
      createdAt: Date;
      updatedAt: Date;
    }

    export interface CreateNewsItemRequest {
      title: string;
      content: string;
      excerpt?: string;
      category: string;
      tags?: string[];
      featuredImage?: string;
      publishedAt?: Date;
      isPinned?: boolean;
    }

    export interface UpdateNewsItemRequest extends Partial<CreateNewsItemRequest> {
      status?: 'draft' | 'published' | 'archived';
    }

    // Feedback
    export interface FeedbackItem {
      id: string;
      type: 'bug' | 'feature_request' | 'improvement' | 'question' | 'other';
      status: 'new' | 'under_review' | 'planned' | 'in_progress' | 'completed' | 'rejected';
      priority: 'low' | 'medium' | 'high';
      title: string;
      description: string;
      category?: string;
      submitterId: string;
      submitterName: string;
      submitterEmail: string;
      votes: number;
      voters?: string[];
      attachments?: {
        id: string;
        name: string;
        url: string;
        type: string;
        size: number;
      }[];
      comments?: {
        id: string;
        authorId: string;
        authorName: string;
        content: string;
        createdAt: Date;
      }[];
      assigneeId?: string;
      assigneeName?: string;
      estimatedCompletion?: Date;
      completedAt?: Date;
      rejectionReason?: string;
      createdAt: Date;
      updatedAt: Date;
    }

    export interface CreateFeedbackRequest {
      type: 'bug' | 'feature_request' | 'improvement' | 'question' | 'other';
      title: string;
      description: string;
      category?: string;
      priority?: 'low' | 'medium' | 'high';
      attachments?: {
        name: string;
        url: string;
        type: string;
        size: number;
      }[];
    }

    export interface UpdateFeedbackRequest extends Partial<CreateFeedbackRequest> {
      status?: 'new' | 'under_review' | 'planned' | 'in_progress' | 'completed' | 'rejected';
      assigneeId?: string;
      estimatedCompletion?: Date;
      rejectionReason?: string;
    }

    // Reviews
    export interface Review {
      id: string;
      type: 'product' | 'service' | 'support' | 'app';
      rating: number; // 1-5
      title: string;
      content: string;
      reviewerId: string;
      reviewerName: string;
      reviewerEmail: string;
      reviewerAvatar?: string;
      conversationId?: string;
      status: 'pending' | 'approved' | 'rejected';
      isVerified: boolean;
      isPinned: boolean;
      isFeatured: boolean;
      helpfulCount: number;
      helpfulVoters?: string[];
      response?: {
        content: string;
        responderId: string;
        responderName: string;
        respondedAt: Date;
      };
      metadata?: {
        orderId?: string;
        productId?: string;
        ticketId?: string;
        [key: string]: unknown;
      };
      createdAt: Date;
      updatedAt: Date;
    }

    export interface CreateReviewRequest {
      type: 'product' | 'service' | 'support' | 'app';
      rating: number;
      title: string;
      content: string;
      metadata?: {
        orderId?: string;
        productId?: string;
        ticketId?: string;
        [key: string]: unknown;
      };
    }

    export interface UpdateReviewRequest extends Partial<CreateReviewRequest> {
      status?: 'pending' | 'approved' | 'rejected';
      isPinned?: boolean;
      isFeatured?: boolean;
    }

    // Settings
    export interface HelpdeskSettings {
      general: {
        companyName: string;
        supportEmail: string;
        defaultLanguage: string;
        timezone: string;
        businessHours: BusinessHours;
      };
      tickets: {
        autoAssignment: boolean;
        requireApproval: boolean;
        allowCustomerCreation: boolean;
        defaultPriority: TicketPriority;
        defaultStatus: TicketStatus;
        autoCloseAfterDays?: number;
        mergeThreshold?: number;
      };
      notifications: {
        emailNotifications: boolean;
        pushNotifications: boolean;
        smsNotifications: boolean;
        notifyOnNewTicket: boolean;
        notifyOnAssignment: boolean;
        notifyOnStatusChange: boolean;
        notifyOnCustomerReply: boolean;
        notifyOnSLABreach: boolean;
      };
      satisfaction: {
        enableSurveys: boolean;
        sendAfterResolution: boolean;
        delayMinutes?: number;
        surveyTemplate?: string;
      };
      integrations: {
        slack?: {
          enabled: boolean;
          webhookUrl: string;
          channel?: string;
        };
        email?: {
          enabled: boolean;
          incomingServer: string;
          outgoingServer: string;
          username: string;
        };
        chat?: {
          enabled: boolean;
          provider: string;
          apiKey: string;
        };
      };
      customization: {
        logoUrl?: string;
        primaryColor?: string;
        customCSS?: string;
        emailTemplate?: string;
        customFields?: {
          name: string;
          type: 'text' | 'number' | 'date' | 'select' | 'multiselect';
          required: boolean;
          options?: string[];
        }[];
      };
    }

    export type UpdateSettingsRequest = Partial<HelpdeskSettings>;

    // Widget Settings
    export interface WidgetSettings {
      id?: string;
      widgetId?: string;
      widgetName?: string;
      pageHome?: boolean;
      pageChat?: boolean;
      pageHelp?: boolean;
      pageParcelTracking?: boolean;
      pageChangelog?: boolean;
      pageNews?: boolean;
      pageFeedback?: boolean;
      pageAnnouncements?: boolean;
      pageEventSignUp?: boolean;
      colorPrimary?: string;
      colorButton?: string;
      colorButtonText?: string;
      colorLauncher?: string;
      colorHeader?: string;
      colorAccent?: string;
      borderRadius?: string;
      fontSize?: string;
      typographyText?: string;
      typographyBackground?: string;
      startingPage?: string;
      position?: string;
      autoOpen?: boolean;
      showWelcomeMessage?: boolean;
      welcomeMessage?: string;
      companyLogoUrl?: string;
      showBranding?: boolean;
      emailCollection?: string;
      // Chat interface colors
      chatBackgroundColor?: string;
      userBubbleColor?: string;
      userBubbleTextColor?: string;
      agentBubbleColor?: string;
      agentBubbleTextColor?: string;
      createdAt?: Date;
      updatedAt?: Date;
    }

    export type UpdateWidgetSettingsRequest = Partial<WidgetSettings>;

    // Filter Types
    // Article Folder Types
    // WeldAgent AI Assistant Types
    export interface WeldAgentConfig {
      id?: string;
      systemInstructions?: string;
      knowledgePermissions?: Record<string, boolean>;
      escalationSettings?: Record<string, unknown>;
      isActive?: boolean;
      createdAt?: Date;
      updatedAt?: Date;
    }

    export interface AiConversation {
      id?: string;
      sessionId: string;
      customerEmail?: string;
      customerName?: string;
      status: 'ai_active' | 'waiting_for_human' | 'transferred_to_human' | 'resolved' | 'converted_to_ticket';
      conversationContext?: Record<string, unknown>;
      transferredAt?: Date;
      assignedAgentId?: string;
      assignedAgentName?: string;
      escalationReason?: string;
      urgency?: 'low' | 'medium' | 'high' | 'urgent';
      ticketId?: string;
      createdAt?: Date;
      updatedAt?: Date;
      messages?: AiMessage[];
    }

    export interface AiResponse {
      messageId?: string;
      content: string;
      shouldEscalate?: boolean;
      shouldCreateTicket?: boolean;
      escalationReason?: string;
      metadata?: Record<string, unknown>;
    }

    // ===========================
    // Channel Integration Types
    // ===========================

    export type ChannelProvider =
      | 'discord'
      | 'slack'
      | 'teams'
      | 'facebook'
      | 'instagram'
      | 'twitter'
      | 'whatsapp'
      | 'telegram'
      | 'gmail'
      | 'outlook'
      | 'imap';

    export type ChannelIntegrationStatus = 'connected' | 'disconnected' | 'error' | 'pending';

    /**
     * Channel integration - represents a connected channel (e.g., Discord server, Slack workspace)
     */
    export interface ChannelIntegration {
      id: string;
      provider: ChannelProvider;
      status: ChannelIntegrationStatus;
      name: string;
      /** Account/workspace info from the provider */
      accountInfo?: {
        id: string;
        name: string;
        email?: string;
        avatar?: string;
        /** Provider-specific metadata (e.g., server name for Discord) */
        metadata?: Record<string, unknown>;
      };
      /** Provider-specific configuration */
      config?: Record<string, unknown>;
      /** When the OAuth token expires */
      tokenExpiresAt?: Date;
      /** Last sync timestamp */
      lastSyncAt?: Date;
      /** Error message if status is 'error' */
      errorMessage?: string;
      createdAt: Date;
      updatedAt: Date;
    }

    /**
     * Response for listing channel integrations
     */
    export interface ChannelIntegrationsResponse {
      integrations: ChannelIntegration[];
    }

    /**
     * Request to initiate OAuth flow
     */
    /**
     * Response from initiating OAuth flow
     */
    /**
     * Request to handle OAuth callback
     * When the frontend exchanges the code, it includes the tokens directly
     */
    export interface HandleOAuthCallbackRequest {
      provider: ChannelProvider;
      code: string;
      state: string;
      /** Pre-exchanged tokens (if frontend does the exchange) */
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      tokenType?: string;
      scope?: string;
      /** Account info from provider */
      accountInfo?: {
        id?: string;
        name?: string;
        email?: string;
        avatar?: string;
      };
      /** Discord-specific guild ID */
      guildId?: string;
    }

    /**
     * Response from OAuth callback handling
     */
    export interface HandleOAuthCallbackResponse {
      integration: ChannelIntegration;
      message: string;
    }

    /**
     * Request to disconnect an integration
     */
    /**
     * Response from testing a channel connection
     */
    export interface TestChannelConnectionResponse {
      success: boolean;
      message: string;
      details?: Record<string, unknown>;
    }

    /**
     * Request to save a token-based integration (like Telegram)
     */
    export interface SaveTokenIntegrationRequest {
      provider: ChannelProvider;
      token: string;
      config?: Record<string, unknown>;
    }

    // ===========================
    // Discord Settings Types
    // ===========================

    /**
     * Discord channel information
     */
    export interface DiscordChannelInfo {
      channelId: string;
      channelName?: string;
      enabled: boolean;
    }

    /**
     * Discord ticket panel configuration
     */
    export interface DiscordTicketPanel {
      messageId: string;
      channelId: string;
      channelName?: string;
      embedTitle?: string;
      embedDescription?: string;
      embedColor?: string;
      buttonText?: string;
      buttonStyle?: number;
      postedAt?: Date;
    }

    /**
     * Discord integration settings
     */
    export interface DiscordIntegrationSettings {
      supportChannels: DiscordChannelInfo[];
      processDirectMessages: boolean;
      ignoreBots: boolean;
      supportPrefix?: string;
      autoReplyMessage?: string;
      botDisplayName?: string;
      botAvatarUrl?: string;
      ticketPanel?: DiscordTicketPanel | null;
    }

    /**
     * Request to update Discord settings
     */
    export interface UpdateDiscordSettingsRequest {
      supportChannels?: DiscordChannelInfo[];
      processDirectMessages?: boolean;
      ignoreBots?: boolean;
      supportPrefix?: string;
      autoReplyMessage?: string;
      botDisplayName?: string;
      botAvatarUrl?: string;
      ticketPanel?: DiscordTicketPanel;
    }

    /**
     * Request to post a Discord ticket panel
     */
    export interface PostDiscordTicketPanelRequest {
      channelId: string;
      channelName?: string;
      embedTitle?: string;
      embedDescription?: string;
      embedColor?: string;
      buttonText?: string;
      buttonStyle?: number;
    }

    /**
     * Response from posting a Discord ticket panel
     */
    export interface PostDiscordTicketPanelResponse {
      messageId: string;
      ticketPanel: DiscordTicketPanel;
    }

    /**
     * Discord guild information with available channels
     */
    export interface DiscordGuildInfo {
      guildId: string;
      guildName: string;
      channels: DiscordChannelInfo[];
    }

    /**
     * Request to send a Discord message
     */
    export interface SendDiscordMessageRequest {
      channelId: string;
      content: string;
      conversationId?: string;
    }

    /**
     * Response from sending a Discord message
     */
    export interface SendDiscordMessageResponse {
      success: boolean;
      messageId?: string;
      message: string;
    }

    // ===========================
    // Slack Settings Types
    // ===========================

    /**
     * Slack channel information
     */
    export interface SlackChannelInfo {
      channelId: string;
      channelName?: string;
      enabled: boolean;
    }

    /**
     * Slack integration settings
     */
    export interface SlackIntegrationSettings {
      supportChannels: SlackChannelInfo[];
      processDirectMessages: boolean;
      ignoreBots: boolean;
      supportPrefix?: string;
      autoReplyMessage?: string;
      useThreadedReplies: boolean;
      createThreadPerConversation: boolean;
    }

    /**
     * Request to update Slack settings
     */
    export interface UpdateSlackSettingsRequest {
      supportChannels?: SlackChannelInfo[];
      processDirectMessages?: boolean;
      ignoreBots?: boolean;
      supportPrefix?: string;
      autoReplyMessage?: string;
      useThreadedReplies?: boolean;
      createThreadPerConversation?: boolean;
    }

    /**
     * Slack workspace information with available channels
     */
    export interface SlackWorkspaceInfo {
      workspaceId: string;
      workspaceName: string;
      iconUrl?: string;
      channels: SlackChannelInfo[];
    }

    /**
     * Request to send a Slack message
     */
    export interface SendSlackMessageRequest {
      channelId: string;
      content: string;
      threadTs?: string;
      conversationId?: string;
      replyBroadcast?: boolean;
    }

    /**
     * Response from sending a Slack message
     */
    export interface SendSlackMessageResponse {
      success: boolean;
      messageTs?: string;
      channelId?: string;
      message: string;
    }

    /**
     * Slack OAuth callback request
     */
    export interface SlackOAuthCallbackRequest {
      code: string;
      state?: string;
      teamId?: string;
      accessToken?: string;
      botUserId?: string;
      teamName?: string;
      scope?: string;
      appId?: string;
    }

    // =========================================================================
    // Ticket Types
    // =========================================================================

    }
}
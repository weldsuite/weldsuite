/**
 * CRM Application Types
 * Customer Relationship Management
 */

import { BaseEntity, Address, Money } from '../common.types';

export namespace CRM {
  /**
   * Customer - Unified B2C and B2B customer model
   * B2B customers (companies) have contacts within them
   */
  export interface Customer extends BaseEntity {
    // Customer Type
    type: 'b2c' | 'b2b';

    // B2C Fields (Individual Person)
    firstName?: string;
    lastName?: string;
    fullName?: string;
    dateOfBirth?: Date;
    gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say';

    // B2B Fields (Company)
    companyName?: string;
    tradingName?: string;
    registrationNumber?: string;
    vatNumber?: string;
    industry?: string;
    employeeCount?: string;
    annualRevenue?: Money;
    website?: string;
    avatarUrl?: string;

    // B2B Contacts (People within the company)
    contacts?: Contact[];
    primaryContactId?: string;

    // Common Contact Information
    email?: string;
    alternateEmails?: string[];
    phone?: string;
    mobile?: string;
    fax?: string;

    // Address
    billingAddress?: Address;
    shippingAddress?: Address;
    addresses?: CustomerAddress[];

    // Classification
    segment?: CustomerSegment;
    status: CustomerStatus;
    rating?: CustomerRating;
    source?: string;

    // Sales Information
    ownerId?: string; // Assigned sales rep
    territoryId?: string;
    accountManagerId?: string;

    // Relationship
    parentPartyId?: string; // For subsidiaries
    isKeyAccount?: boolean;

    // Preferences
    preferredContactMethod?: ContactMethod;
    preferredLanguage?: string;
    timezone?: string;

    // Marketing
    marketingConsent?: boolean;
    emailOptIn?: boolean;
    smsOptIn?: boolean;
    doNotCall?: boolean;

    // Financial
    creditLimit?: Money;
    paymentTerms?: string;
    taxExempt?: boolean;
    currency?: string;

    // Important Dates
    firstContactDate?: Date;
    lastContactDate?: Date;
    nextFollowUpDate?: Date;
    contractRenewalDate?: Date;

    // Lifecycle
    lifecycleStage?: LifecycleStage;
    relationshipSince?: Date;
    churnedAt?: Date;
    churnReason?: string;

    // Scoring
    leadScore?: number;
    satisfactionScore?: number;
    npsScore?: number;

    // Activity Summary
    totalOpportunities?: number;
    wonOpportunities?: number;
    totalRevenue?: Money;
    lifetimeValue?: Money;
    averageDealSize?: Money;

    // Social Media
    linkedinUrl?: string;
    twitterHandle?: string;
    facebookUrl?: string;

    // Favorite
    isFavorite?: boolean;

    // Tags & Custom Fields
    tags?: string[];
    customFields?: Record<string, any>;

    // Notes
    notes?: string;
    internalNotes?: string;
  }

  /**
   * Contact - Person within a B2B customer (company)
   */
  export interface Contact extends BaseEntity {
    // Parent Customer (must be B2B)
    customerId: string;

    // Personal Information
    firstName: string;
    lastName: string;
    fullName?: string;
    title?: string;
    department?: string;

    // Contact Details
    email: string;
    directPhone?: string;
    mobilePhone?: string;
    extension?: string;

    // Role & Influence
    role?: ContactRole;
    isPrimary: boolean;
    isDecisionMaker?: boolean;
    isBillingContact?: boolean;
    isTechnicalContact?: boolean;
    influenceLevel?: InfluenceLevel;

    // Preferences
    preferredContactMethod?: ContactMethod;
    preferredLanguage?: string;
    bestTimeToContact?: string;

    // Marketing
    emailOptIn?: boolean;
    doNotCall?: boolean;

    // Social
    linkedinUrl?: string;
    twitterHandle?: string;

    // Activity
    lastContactedAt?: Date;
    lastActivityType?: string;

    // Status
    status: ContactStatus;

    // Notes
    notes?: string;
    interests?: string[];
  }

  /**
   * Lead - Potential customer
   */
  export interface Lead extends BaseEntity {
    // Lead Information
    firstName?: string;
    lastName?: string;
    fullName?: string;
    companyName?: string;
    title?: string;

    // Contact
    email: string;
    phone?: string;
    mobile?: string;
    website?: string;

    // Address
    address?: Address;

    // Lead Details
    source: LeadSource;
    channel?: string;
    campaign?: string;
    medium?: string;

    // Status
    status: LeadStatus;
    rating?: LeadRating;
    score?: number;

    // Assignment
    ownerId?: string;
    assignedAt?: Date;

    // Qualification
    isQualified?: boolean;
    qualifiedAt?: Date;
    disqualifiedReason?: string;

    // Interest
    productInterest?: string[];
    budget?: Money;
    timeline?: string;
    authority?: boolean;
    need?: string;

    // Conversion
    convertedAt?: Date;
    convertedToCustomerId?: string;
    convertedToOpportunityId?: string;

    // Activity
    firstResponseAt?: Date;
    lastActivityAt?: Date;
    numberOfTouches?: number;

    // Notes
    notes?: string;
    nextAction?: string;
  }

  /**
   * Opportunity/Deal
   */
  export interface Opportunity extends BaseEntity {
    // Basic Information
    name: string;
    description?: string;

    // Customer
    customerId: string;
    customerName?: string;
    contactIds?: string[];
    primaryContactId?: string;

    // Value
    amount: Money;
    expectedRevenue?: Money;
    recurringRevenue?: Money;
    contractLength?: number; // months

    // Sales Process
    stage: OpportunityStage;
    probability?: number;
    pipeline?: string;
    salesProcess?: string;

    // Dates
    closeDate: Date;
    actualCloseDate?: Date;
    startDate?: Date;

    // Competition
    competitors?: Competitor[];
    competitionStatus?: CompetitionStatus;
    winLossReason?: string;

    // Products/Services
    lineItems?: OpportunityLineItem[];

    // Team
    ownerId: string;
    teamMembers?: string[];

    // Source
    leadSource?: string;
    campaign?: string;

    // Type
    type?: OpportunityType;
    category?: string;

    // Status
    status: OpportunityStatus;
    forecastCategory?: ForecastCategory;

    // Next Steps
    nextStep?: string;
    nextStepDate?: Date;

    // Risk
    riskLevel?: RiskLevel;
    riskReason?: string;

    // Documents
    proposalUrl?: string;
    contractUrl?: string;
    attachments?: string[];

    // Activity
    lastActivityDate?: Date;
    daysInCurrentStage?: number;
    totalActivities?: number;

    // Custom Fields
    customFields?: Record<string, any>;
    tags?: string[];
  }

  /**
   * Activity - Interactions with customers
   */
  export interface Activity extends BaseEntity {
    // Type
    type: ActivityType;
    subject: string;
    description?: string;

    // Related To
    relatedTo: RelatedEntity;
    relatedToId: string;
    relatedToName?: string;

    // Participants
    customerId?: string;
    contactId?: string;
    leadId?: string;
    opportunityId?: string;
    assignedToId: string;

    // Timing
    dueDate?: Date;
    startTime?: Date;
    endTime?: Date;
    duration?: number; // minutes

    // Status
    status: ActivityStatus;
    priority?: ActivityPriority;

    // Location
    location?: string;
    isVirtual?: boolean;
    meetingUrl?: string;

    // Call Specific
    callDirection?: 'inbound' | 'outbound';
    callDuration?: number;
    callRecordingUrl?: string;

    // Email Specific
    emailMessageId?: string;
    emailSubject?: string;
    emailFrom?: string;
    emailTo?: string[];
    emailCc?: string[];

    // Meeting Specific
    attendees?: string[];
    meetingAgenda?: string;
    meetingNotes?: string;

    // Outcome
    outcome?: string;
    nextAction?: string;
    followUpDate?: Date;

    // Attachments
    attachments?: string[];

    // Metadata
    tags?: string[];
    customFields?: Record<string, any>;
  }

  /**
   * Campaign - Marketing campaigns
   */
  /**
   * Quote - Sales quotation
   */
  export interface Quote extends BaseEntity {
    // Identification
    quoteNumber: string;
    name: string;

    // Customer
    customerId: string;
    contactId?: string;
    opportunityId?: string;

    // Details
    lineItems: QuoteLineItem[];

    // Pricing
    subtotal: Money;
    discount?: Money;
    tax?: Money;
    shipping?: Money;
    total: Money;

    // Validity
    validFrom: Date;
    validUntil: Date;

    // Status
    status: QuoteStatus;

    // Terms
    paymentTerms?: string;
    deliveryTerms?: string;
    termsAndConditions?: string;

    // Approval
    requiresApproval?: boolean;
    approvedBy?: string;
    approvedAt?: Date;

    // Signature
    signatureRequired?: boolean;
    signedBy?: string;
    signedAt?: Date;
    signatureUrl?: string;

    // Documents
    pdfUrl?: string;
    sentAt?: Date;
    viewedAt?: Date;

    // Notes
    notes?: string;
    internalNotes?: string;
  }

  // ==========================================
  // Enums
  // ==========================================

  // Supporting Types
  /**
   * Meeting Bot Session - Bot instance for recording Google Meet meetings
   */
  export interface MeetingBotSession extends BaseEntity {
    // User
    userId: string;

    // Meeting Information
    meetingUrl: string;
    meetingId?: string;

    // Status
    status: MeetingBotStatus;

    // Configuration
    enableTranscription: boolean;
    enableDiarization: boolean;
    language: string;

    // Timing
    joinedAt?: Date;
    leftAt?: Date;
    duration?: number; // seconds
    participantCount?: number;

    // Relationships
    transcription?: Transcription;
    audioRecording?: AudioRecording;
  }

  /**
   * Audio Recording metadata
   */
  /**
   * Transcription with AI analysis
   */
  export interface Transcription extends BaseEntity {
    sessionId: string;
    status: TranscriptionStatus;
    processingStartedAt?: Date;
    processingCompletedAt?: Date;

    // Content
    fullText?: string;
    summary?: string;
    actionItems?: string[];

    // Metadata
    model: string;
    provider?: string;
    language?: string;
    speakerCount?: number;
    wordCount?: number;
    confidence?: number;

    // Segments
    segments?: TranscriptSegment[];
  }

  /**
   * Individual transcript segment with speaker info
   */
  // Meeting Bot Types
  }
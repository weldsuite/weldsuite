/**
 * Credits API Types
 *
 * Type definitions for the unified credits system.
 * Credits are billed as part of the subscription - users choose their credit
 * allocation when subscribing and it's invoiced together with their plan.
 */

export namespace Credits {
  /**
   * Credit balance and period information
   */
  export interface Balance {
    currentBalance: number;
    // Subscription-based allocation breakdown
    planCredits: number;        // Base credits included in plan
    subscribedCredits: number;  // Additional credits purchased with subscription
    monthlyAllocation: number;  // Total = planCredits + subscribedCredits
    rolledOverCredits: number;
    periodStart: string;
    periodEnd: string;
    daysRemaining: number;
    usagePercentage: number;
    isLow: boolean; // < 10% remaining
    isExhausted: boolean; // 0 remaining
  }

  /**
   * Subscription credits configuration
   */
  export interface SubscriptionCredits {
    planCredits: number;
    subscribedCredits: number;
    totalMonthly: number;
    stripePriceId?: string;
    stripeItemId?: string;
  }

  /**
   * Credit transaction record
   */
  /**
   * Transaction types
   */
  /**
   * Service types that consume credits
   */
  /**
   * Transaction metadata
   */
  /**
   * Credit rates configuration
   */
  export interface CreditRates {
    aiTokens: number;                // Credits per 1000 tokens
    parcelLabel: number;             // Credits per label
    meetingBotMinute: number;        // Credits per minute
    callTranscriptionMinute: number; // Credits per minute for call transcription
    voipCallMinute: number;          // Credits per minute for VoIP calls
  }

  /**
   * Default credit rates
   */
  /**
   * Credit package for purchase
   */
  export interface Package {
    id: string;
    name: string;
    description?: string;
    credits: number;
    price: number;
    currency: string;
    stripePriceId?: string;
    isPopular: boolean;
  }

  /**
   * Consume credits request
   */
  export interface ConsumeRequest {
    serviceType: ServiceType;
    amount: number;
    referenceId: string;
    referenceType: string;
    description?: string;
    metadata?: TransactionMetadata;
  }

  /**
   * Consume credits result
   */
  export interface ConsumeResult {
    success: boolean;
    creditsDeducted: number;
    newBalance: number;
    transactionId?: string;
    error?: 'insufficient_credits' | 'service_error';
    message?: string;
  }

  /**
   * Credits availability check
   */
  export interface AvailabilityCheck {
    available: boolean;
    currentBalance: number;
    required: number;
    shortfall: number;
    message?: string;
  }

  /**
   * Purchase checkout request
   */
  /**
   * Purchase checkout result
   */
  /**
   * Transaction list filters
   */
  export interface TransactionFilters {
    page?: number;
    pageSize?: number;
    type?: TransactionType;
    serviceType?: ServiceType;
    from?: string;
    to?: string;
  }

  /**
   * Paginated transaction response
   */
  export interface TransactionListResponse {
    success: boolean;
    data: Transaction[];
    pagination: {
      page: number;
      pageSize: number;
      totalCount: number;
      totalPages: number;
      hasMore: boolean;
    };
  }
}

/**
 * Wallet Application Types
 * Digital wallet and payment management
 */

import { BaseEntity, Money, User } from '../common.types';

export namespace Wallet {
  /**
   * Wallet - User's digital wallet
   */
  export interface Wallet extends BaseEntity {
    // Owner
    userId: string;
    userEmail?: string;
    userName?: string;

    // Identification
    walletNumber: string;
    walletType: WalletType;

    // Balance
    balance: Money;
    availableBalance: Money;
    pendingBalance?: Money;
    reservedBalance?: Money;

    // Currency
    primaryCurrency: string;
    supportedCurrencies?: string[];

    // Limits
    dailyLimit?: Money;
    monthlyLimit?: Money;
    transactionLimit?: Money;

    // Status
    status: WalletStatus;
    isVerified: boolean;
    verificationLevel?: VerificationLevel;

    // Security
    pin?: string; // hashed
    twoFactorEnabled?: boolean;
    biometricEnabled?: boolean;
    lastAccessedAt?: Date;
    lastAccessedFrom?: string;

    // Freeze
    isFrozen?: boolean;
    frozenAt?: Date;
    frozenReason?: string;
    unfrozenAt?: Date;

    // Settings
    autoReload?: AutoReloadSettings;
    notifications?: WalletNotificationSettings;

    // Statistics
    totalTransactions?: number;
    totalSpent?: Money;
    totalReceived?: Money;
    totalWithdrawn?: Money;

    // Rewards
    loyaltyPoints?: number;
    cashbackBalance?: Money;
    rewardsLevel?: string;

    // Metadata
    tags?: string[];
    customFields?: Record<string, any>;
  }

  /**
   * Transaction - Wallet transaction
   */
  export interface Transaction extends BaseEntity {
    // Transaction ID
    transactionId: string;
    referenceNumber?: string;

    // Wallet
    walletId: string;

    // Type & Direction
    type: TransactionType;
    direction: 'debit' | 'credit';
    category?: TransactionCategory;

    // Amount
    amount: Money;
    fee?: Money;
    tax?: Money;
    netAmount?: Money;

    // Currency
    currency: string;
    exchangeRate?: number;
    originalAmount?: Money;
    originalCurrency?: string;

    // Status
    status: TransactionStatus;

    // Parties
    senderId?: string;
    senderName?: string;
    senderWalletId?: string;

    receiverId?: string;
    receiverName?: string;
    receiverWalletId?: string;

    merchantId?: string;
    merchantName?: string;

    // Payment Method
    paymentMethod?: PaymentMethod;
    paymentMethodId?: string;

    // Description
    description?: string;
    notes?: string;

    // Order Reference
    orderId?: string;
    orderNumber?: string;
    invoiceId?: string;

    // Processing
    processedAt?: Date;
    settledAt?: Date;
    failedAt?: Date;
    failureReason?: string;

    // Reversal
    isReversed?: boolean;
    reversalId?: string;
    reversedAt?: Date;
    reversalReason?: string;

    // Location
    location?: TransactionLocation;

    // Metadata
    metadata?: Record<string, any>;
    tags?: string[];
  }

  /**
   * Payment Method
   */
  export interface PaymentMethod extends BaseEntity {
    walletId: string;

    // Type
    type: PaymentMethodType;
    provider?: string;

    // Card Details (if applicable)
    cardNumber?: string; // masked
    cardHolderName?: string;
    cardBrand?: CardBrand;
    expiryMonth?: number;
    expiryYear?: number;
    last4Digits?: string;

    // Bank Details (if applicable)
    bankName?: string;
    accountNumber?: string; // masked
    routingNumber?: string;
    accountType?: 'checking' | 'savings';

    // Digital Wallet (if applicable)
    digitalWalletId?: string;
    digitalWalletType?: 'apple_pay' | 'google_pay' | 'samsung_pay';

    // Status
    isDefault: boolean;
    isVerified: boolean;
    status: PaymentMethodStatus;

    // Billing Address
    billingAddress?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };

    // Verification
    verifiedAt?: Date;
    verificationMethod?: string;

    // Metadata
    nickname?: string;
    color?: string;
    icon?: string;
  }

  /**
   * Top-up/Reload Request
   */
  export interface TopUpRequest extends BaseEntity {
    walletId: string;

    // Amount
    amount: Money;
    fee?: Money;
    totalAmount?: Money;

    // Payment
    paymentMethodId: string;
    paymentMethod?: PaymentMethod;

    // Status
    status: TopUpStatus;

    // Processing
    processedAt?: Date;
    failedAt?: Date;
    failureReason?: string;

    // Transaction
    transactionId?: string;

    // Auto Top-up
    isAutoTopUp?: boolean;
    triggerBalance?: Money;
  }

  /**
   * Withdrawal Request
   */
  export interface WithdrawalRequest extends BaseEntity {
    walletId: string;

    // Amount
    amount: Money;
    fee?: Money;
    netAmount?: Money;

    // Destination
    destinationType: 'bank_account' | 'card' | 'paypal' | 'other';
    destinationId?: string;
    destinationDetails?: any;

    // Status
    status: WithdrawalStatus;

    // Processing
    requestedAt: Date;
    processedAt?: Date;
    completedAt?: Date;
    failedAt?: Date;
    failureReason?: string;

    // Approval
    requiresApproval?: boolean;
    approvedBy?: string;
    approvedAt?: Date;

    // Transaction
    transactionId?: string;

    // Notes
    notes?: string;
    reason?: string;
  }

  /**
   * Transfer - Wallet to wallet transfer
   */
  export interface Transfer extends BaseEntity {
    // Parties
    senderWalletId: string;
    senderName?: string;

    receiverWalletId: string;
    receiverIdentifier?: string; // email, phone, or wallet number
    receiverName?: string;

    // Amount
    amount: Money;
    fee?: Money;
    netAmount?: Money;

    // Status
    status: TransferStatus;

    // Description
    description?: string;
    notes?: string;
    reference?: string;

    // Type
    type: 'instant' | 'scheduled' | 'recurring';
    scheduledDate?: Date;
    recurringPattern?: RecurringPattern;

    // Processing
    initiatedAt: Date;
    completedAt?: Date;
    failedAt?: Date;
    failureReason?: string;

    // Transactions
    senderTransactionId?: string;
    receiverTransactionId?: string;
  }

  /**
   * Card - Virtual or physical card linked to wallet
   */
  export interface Card extends BaseEntity {
    walletId: string;

    // Card Details
    cardNumber?: string; // encrypted/masked
    cardType: 'virtual' | 'physical';
    cardBrand: CardBrand;

    // Cardholder
    cardholderName: string;

    // Validity
    expiryMonth: number;
    expiryYear: number;
    cvv?: string; // encrypted

    // Status
    status: CardStatus;
    isActive: boolean;
    isLocked?: boolean;

    // Limits
    dailyLimit?: Money;
    monthlyLimit?: Money;
    transactionLimit?: Money;
    atmWithdrawalLimit?: Money;

    // PIN
    isPinSet?: boolean;
    pinAttempts?: number;

    // Usage
    allowOnlineTransactions?: boolean;
    allowInternationalTransactions?: boolean;
    allowATMWithdrawals?: boolean;
    allowContactlessPayments?: boolean;

    // Physical Card
    shippingAddress?: any;
    shippedAt?: Date;
    deliveredAt?: Date;
    activatedAt?: Date;

    // Statistics
    totalSpent?: Money;
    transactionCount?: number;
    lastUsedAt?: Date;

    // Design
    design?: string;
    color?: string;
  }

  /**
   * Reward - Cashback and loyalty rewards
   */
  /**
   * Budget - Spending budget/limit
   */
  // ==========================================
  // Supporting Types
  // ==========================================

  // ==========================================
  // Enums
  // ==========================================

  }
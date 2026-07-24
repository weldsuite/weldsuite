/**
 * Billing API Types
 *
 * This module contains all types specific to the Billing application.
 * All types are namespaced under 'Billing' to avoid conflicts with other modules.
 *
 * Billing is managed via billing-worker (Stripe). See actions/billing-actions.ts
 * for server actions and lib/api/billing-worker-client.ts for the worker client.
 */

import { BaseEntity } from '../complete-api.types';

// The `Billing.X` dot-access pattern below is consumed across many files
// outside this module's scope (components/settings, hooks/queries, app/settings);
// converting away from a namespace would require updating every call site.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Billing {
  // ==========================================
  // Enums
  // ==========================================

  export enum SubscriptionStatus {
    Active = 'Active',
    Trialing = 'Trialing',
    PastDue = 'PastDue',
    Canceled = 'Canceled',
    Paused = 'Paused'
  }

  export enum BillingCycle {
    Monthly = 'Monthly',
    Yearly = 'Yearly'
  }

  // ==========================================
  // Subscription
  // ==========================================

  export interface Subscription extends BaseEntity {
    planId: string;
    planName: string;
    planSlug?: string;
    status: SubscriptionStatus;
    cycle: BillingCycle;
    pricePerCycle: number; // In cents
    purchasedSeats: number;
    usedSeats: number;
    startDate: Date;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: Date;
    cancelationEffectiveDate?: Date;
    trialEnd?: Date;
    currentUsage?: UsageSummary;
  }

  // ==========================================
  // Usage
  // ==========================================

  export interface UsageSnapshot {
    memberCount: number;
    emailsSentThisMonth: number;
    aiCreditsUsedThisMonth: number;
    creditsBalance: number;
    creditsMonthlyAllocation: number;
  }

  export type UsageSummary = UsageSnapshot;

  // ==========================================
  // Billing Plans
  // ==========================================

  export interface BillingPlan extends BaseEntity {
    name: string;
    slug: string;
    description?: string;
    monthlyPrice: number; // In cents
    yearlyPrice?: number; // In cents
    maxMembers?: number; // null = unlimited
    isPerSeatPricing: boolean;
    pricePerSeat?: number; // In cents
    emailsPerMonth: number;
    aiCreditsPerMonth: number;
    overageRatePerGb?: number; // In cents
    overageRatePerEmail?: number; // In cents
    overageRatePerAiCredit?: number; // In cents
    isActive: boolean;
    displayOrder: number;
    highlighted: boolean;
    requiresContact: boolean;
    badge?: string;
    hasApiAccess: boolean;
    // Feature limits
    maxDomains?: number | null;
    maxEmailAccounts?: number | null;
    maxCustomDomains?: number | null; // null = unlimited, 0 = disabled
    taskExecutions?: number;
    // Boolean features
    removeBranding?: boolean;
    prioritySupport?: boolean;
    customEmailDomain?: boolean;
    sso?: boolean;
    customIntegrations?: boolean;
  }

  // ==========================================
  // Plan Limits & Downgrade Validation
  // ==========================================

  export interface PlanLimits {
    planId: string;
    planName: string;
    maxMembers?: number; // null = unlimited
    purchasedSeats: number;
    emailsPerMonth: number;
    aiCreditsPerMonth: number;
    monthlyCredits: number;
    currentUsage: UsageSnapshot;
  }

  export interface DowngradeValidationResult {
    canDowngrade: boolean;
    blockers: string[];
  }
}

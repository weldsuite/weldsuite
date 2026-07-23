
import * as React from 'react';
import { useState, useEffect, useTransition } from 'react';
import { Check, Loader2, AlertCircle, Minus, Plus, ChevronLeft, Info, X } from 'lucide-react';
import NumberFlow from '@number-flow/react';
import { track } from '@/lib/analytics';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Separator } from '@weldsuite/ui/components/separator';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { Slider } from '@weldsuite/ui/components/slider';
import { cn } from '@/lib/utils';
import { PageLoader } from '@/components/page-loader';
import { Billing } from '@/lib/api/types/apps/billing.types';
import { useChangePlan } from '@/hooks/queries/use-billing-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { EnterpriseContactForm } from '@/components/billing/enterprise-contact-form';

// Monthly email options (values in emails)
const EMAIL_CREDIT_OPTIONS = [
  { value: 0, label: '1k' },
  { value: 10000, label: '10k' },
  { value: 25000, label: '25k' },
  { value: 50000, label: '50k' },
  { value: 100000, label: '100k' },
  { value: 250000, label: '250k' },
  { value: 500000, label: '500k' },
  { value: 750000, label: '750k' },
  { value: 1000000, label: '1M' },
  { value: 1500000, label: '1.5M' },
  { value: 2000000, label: '2M' },
  { value: -1, label: 'Custom' },
];

// Price per 1,000 emails in cents by plan
const EMAIL_PRICE_PER_THOUSAND: Record<string, number> = {
  'business': 150,  // $1.50 per 1,000
  'scale': 100,     // $1.00 per 1,000
};

// Get email price based on plan and quantity
const getEmailPrice = (planName: string, emailCount: number): number => {
  if (emailCount <= 0) return 0;
  const pricePerThousand = EMAIL_PRICE_PER_THOUSAND[planName.toLowerCase()] || EMAIL_PRICE_PER_THOUSAND['business'];
  return Math.round((emailCount / 1000) * pricePerThousand);
};

// WeldSuite apps included in plans (same as settings/plans page)
const includedApps = [
  { id: 'crm', name: 'WeldCRM', logo: '/assets/images/weldcrm/logo-light.png', logoClass: 'h-4 w-4' },
  { id: 'mail', name: 'WeldMail', logo: '/assets/images/weldmail/logo-light.png', logoClass: 'h-4 w-4' },
  { id: 'helpdesk', name: 'WeldDesk', logo: '/assets/images/welddesk/logo-light.png', logoClass: 'h-4 w-4' },
  { id: 'projects', name: 'WeldFlow', logo: '/assets/images/weldflow/logo-light.png', logoClass: 'h-[18px] w-[18px]' },
  { id: 'task', name: 'WeldConnect', logo: '/assets/images/weldconnect/logo-light.png', logoClass: 'h-[17px] w-[17px]' },
  { id: 'host', name: 'WeldHost', logo: '/assets/images/weldhost/logo-light.png', logoClass: 'h-[17px] w-[17px]' },
];

// Curated feature lists per plan (matching settings/plans page)
const PLAN_FEATURES: Record<string, string[]> = {
  business: [
    'Up to 25 users (3 user minimum)',
    '250 GB storage per user',
    'API access & webhooks',
    'Custom email domains',
    'Roles & permissions',
    'Standard support',
  ],
  scale: [
    'Unlimited users',
    '1 TB storage per user',
    'Priority support',
    'Advanced roles & permissions',
    '90-day automation history',
    'Call & meeting intelligence',
  ],
  enterprise: [
    'Custom seat limit',
    'SSO / SAML',
    '99.999% uptime SLA',
    'Data residency',
    'Dedicated support',
    'Custom integrations',
  ],
};

interface PricingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPlanChanged?: () => void;
  excludePlans?: string[];
  highlightPlan?: string;
  hideHeaderBar?: boolean;
  featureHighlight?: {
    feature: string;
    description: string;
    plan: string;
  };
}

export function PricingDialog({ open, onOpenChange, onPlanChanged, excludePlans = [], highlightPlan, hideHeaderBar = false, featureHighlight }: PricingDialogProps) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [allPlans, setAllPlans] = useState<Billing.BillingPlan[]>([]);
  const [subscription, setSubscription] = useState<Billing.Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingPlanId, setProcessingPlanId] = useState<string | null>(null);
  const [downgradeBlockers, setDowngradeBlockers] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();
  const changePlanMutation = useChangePlan();
  const { getClient } = useAppApiClient();
  const [seatCounts, setSeatCounts] = useState<Record<string, number>>({});
  const [viewMode, setViewMode] = useState<'plans' | 'checkout'>('plans');
  const [selectedPlanForCheckout, setSelectedPlanForCheckout] = useState<Billing.BillingPlan | null>(null);

  // Checkout form state
  const [checkoutBillingCycle, setCheckoutBillingCycle] = useState<'monthly' | 'annually'>('monthly');
  const [checkoutSeatCount, setCheckoutSeatCount] = useState(1);
  const [checkoutEmailCredits, setCheckoutEmailCredits] = useState(0);
  // Fetch plans and subscription on open
  useEffect(() => {
    if (open) {
      loadData();
      setViewMode('plans');
      setSelectedPlanForCheckout(null);
      track('Pricing Viewed');
    }
  }, [open]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    setDowngradeBlockers([]);

    try {
      const client = await getClient();
      // app-api GET /api/billing/plans-page — same payload, `{ data }` envelope;
      // a failure throws instead of returning `{ success: false, error }`.
      const result = await client.get<{
        data?: { plans: Billing.BillingPlan[]; subscription: Billing.Subscription | null };
      }>('/billing/plans-page');
      if (result.data) {
        // Sort by displayOrder and filter active plans
        const sortedPlans = (result.data.plans || [])
          .filter((p: Billing.BillingPlan) => p.isActive)
          .sort((a: Billing.BillingPlan, b: Billing.BillingPlan) => a.displayOrder - b.displayOrder);
        setAllPlans(sortedPlans);
        setSubscription(result.data.subscription || null);
      } else {
        setError('Failed to load plans');
      }
    } catch (err) {
      setError('Failed to load pricing data');
    } finally {
      setLoading(false);
    }
  };

  const getSeatCount = (planId: string) => seatCounts[planId] || 1;

  const setSeatCount = (planId: string, count: number) => {
    setSeatCounts(prev => ({ ...prev, [planId]: Math.max(1, count) }));
  };

  const getPrice = (plan: Billing.BillingPlan) => {
    if (plan.requiresContact) return null;
    // Prices are stored in cents
    const monthlyPrice = plan.monthlyPrice / 100;
    const yearlyPrice = plan.yearlyPrice ? plan.yearlyPrice / 100 : monthlyPrice * 10;
    const basePrice = billingCycle === 'monthly' ? monthlyPrice : yearlyPrice / 12;

    // For per-seat pricing, multiply by seat count
    if (plan.isPerSeatPricing) {
      return basePrice * getSeatCount(plan.id);
    }
    return basePrice;
  };

  const getPricePerSeat = (plan: Billing.BillingPlan) => {
    if (plan.requiresContact || !plan.isPerSeatPricing) return null;
    const monthlyPrice = plan.monthlyPrice / 100;
    const yearlyPrice = plan.yearlyPrice ? plan.yearlyPrice / 100 : monthlyPrice * 10;
    return billingCycle === 'monthly' ? monthlyPrice : yearlyPrice / 12;
  };

  const getSavingsPercent = (plan: Billing.BillingPlan) => {
    if (!plan.yearlyPrice || plan.monthlyPrice === 0) return 0;
    const monthlyTotal = plan.monthlyPrice * 12;
    return Math.round((1 - plan.yearlyPrice / monthlyTotal) * 100);
  };

  // Filter excluded plans for display (show all plans including current)
  const displayPlans = allPlans.filter(p =>
    !excludePlans.includes(p.name.toLowerCase())
  );

  // A workspace is eligible for the 14-day trial only if it has no subscription
  // yet or is still on the retired free plan — mirrors the backend rule so we
  // never promise a trial to paid customers switching plans.
  const trialEligible = !subscription || subscription.planSlug === 'free';

  const isDowngrade = (plan: Billing.BillingPlan) => {
    if (!subscription) return false;
    const currentPlan = allPlans.find(p => p.id === subscription.planId);
    if (!currentPlan) return false;
    return plan.monthlyPrice < currentPlan.monthlyPrice;
  };

  const isUpgrade = (plan: Billing.BillingPlan) => {
    if (!subscription) return true; // No subscription = everything is an upgrade
    const currentPlan = allPlans.find(p => p.id === subscription.planId);
    if (!currentPlan) return true;
    return plan.monthlyPrice > currentPlan.monthlyPrice;
  };

  const handleSelectPlan = async (plan: Billing.BillingPlan) => {
    if (processingPlanId) return;
    if (isPlanCurrent(plan)) return;

    // Enterprise requires contact
    if (isContactPlan(plan)) {
      return;
    }

    // For paid plans, show the checkout view
    if (plan.monthlyPrice > 0) {
      setSelectedPlanForCheckout(plan);
      setCheckoutSeatCount(1);
      setCheckoutEmailCredits(0);
      setViewMode('checkout');
      return;
    }

    // For free plans, proceed directly
    setProcessingPlanId(plan.id);
    setError(null);

    try {
      startTransition(async () => {
        const result = await changePlanMutation.mutateAsync({
          planId: plan.id,
          seatCount: 1,
          billingCycle,
        });

        if (result.success) {
          onPlanChanged?.();
          onOpenChange(false);
        } else {
          setError('Failed to change plan');
        }
        setProcessingPlanId(null);
      });
    } catch (err: any) {
      setError(err.message || 'An error occurred');
      setProcessingPlanId(null);
    }
  };

  const handleCheckout = async () => {
    if (!selectedPlanForCheckout) return;

    setProcessingPlanId(selectedPlanForCheckout.id);
    setError(null);
    setDowngradeBlockers([]);

    try {
      // Check if this is a downgrade or if the target plan has a lower seat limit
      const needsValidation = isDowngrade(selectedPlanForCheckout) || (selectedPlanForCheckout.maxMembers != null && subscription && (subscription.usedSeats ?? 0) > selectedPlanForCheckout.maxMembers);
      if (needsValidation) {
        const client = await getClient();
        // app-api POST /api/billing/validate-downgrade — `{ data }` envelope.
        const validation = await client.post<{
          data?: { canDowngrade: boolean; blockers: string[] };
        }>(`/billing/validate-downgrade`, { planId: selectedPlanForCheckout.id });
        if (validation.data && !validation.data.canDowngrade) {
          setDowngradeBlockers(validation.data.blockers);
          setProcessingPlanId(null);
          return;
        }
      }

      // Create Stripe Checkout session and redirect
      startTransition(async () => {
        const cycle = checkoutBillingCycle === 'annually' ? 'yearly' : 'monthly';
        const result = await changePlanMutation.mutateAsync({
          planId: selectedPlanForCheckout.id,
          seats: checkoutSeatCount,
          cycle,
        });

        if ((result as any).url) {
          // Redirect to Stripe Checkout
          window.location.href = (result as any).url;
        } else if (result.success) {
          // Free plan change (no checkout URL needed)
          setViewMode('plans');
          setSelectedPlanForCheckout(null);
          onPlanChanged?.();
          onOpenChange(false);
        } else {
          setError('Failed to create checkout session');
        }
        setProcessingPlanId(null);
      });
    } catch (err: any) {
      setError(err.message || 'An error occurred');
      setProcessingPlanId(null);
    }
  };

  const getButtonText = (plan: Billing.BillingPlan) => {
    if (isPlanCurrent(plan)) return 'Current Plan';
    if (isContactPlan(plan)) return 'Contact sales';
    if (trialEligible && plan.slug === 'business') return 'Start 14-day free trial';
    if (isUpgrade(plan)) return 'Upgrade';
    if (isDowngrade(plan)) return 'Downgrade';
    return 'Select Plan';
  };

  const getPlanFeatures = (plan: Billing.BillingPlan): string[] => {
    const key = plan.name.toLowerCase();
    return PLAN_FEATURES[key] || [];
  };

  const isPlanHighlighted = (plan: Billing.BillingPlan): boolean => {
    if (highlightPlan) {
      return plan.name.toLowerCase() === highlightPlan.toLowerCase();
    }
    return plan.highlighted || plan.slug === 'scale';
  };

  const isContactPlan = (plan: Billing.BillingPlan): boolean => {
    return plan.requiresContact || plan.name.toLowerCase() === 'enterprise';
  };

  const isPlanCurrent = (plan: Billing.BillingPlan): boolean => {
    return plan.id === subscription?.planId;
  };

  // Calculate checkout prices
  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: 'EUR',
    }).format(cents / 100);
  };

  const getCheckoutPrices = () => {
    if (!selectedPlanForCheckout) return null;

    const isAnnual = checkoutBillingCycle === 'annually';
    const monthlyPricePerSeat = selectedPlanForCheckout.monthlyPrice;
    const annualPricePerSeat = selectedPlanForCheckout.yearlyPrice || Math.round(selectedPlanForCheckout.monthlyPrice * 10);
    const pricePerSeat = isAnnual ? annualPricePerSeat : monthlyPricePerSeat;

    // Calculate email price based on plan
    const creditsPriceMonthly = getEmailPrice(selectedPlanForCheckout.name, checkoutEmailCredits);
    const creditsPriceAnnual = creditsPriceMonthly * 12;
    const creditsPrice = isAnnual ? creditsPriceAnnual : creditsPriceMonthly;

    const seatsTotal = pricePerSeat * checkoutSeatCount;
    const subtotal = seatsTotal + creditsPrice;

    return {
      pricePerSeat,
      seatsTotal,
      creditsPrice,
      creditsPriceMonthly,
      subtotal,
      isAnnual,
      annualPricePerSeat,
      monthlyPricePerSeat,
    };
  };

  const checkoutPrices = getCheckoutPrices();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-[960px] max-h-[90vh] !duration-0 !animate-none p-0 overflow-hidden gap-0",
          viewMode === 'checkout' && "h-[616px]"
        )}
        showCloseButton={viewMode !== 'checkout'}
      >
        {viewMode === 'checkout' && selectedPlanForCheckout && checkoutPrices ? (
          /* Checkout View */
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center px-4 h-[55px] border-b shrink-0">
              <Button variant="ghost" size="icon" className="h-7 w-7 mr-2" onClick={() => { setViewMode('plans'); setSelectedPlanForCheckout(null); }}>
                <ChevronLeft className="h-4 w-4 translate-y-px" />
              </Button>
              <h2 className="text-base font-semibold flex-1">Change summary</h2>
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => onOpenChange(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="flex flex-1 min-h-0">
              {/* Left side - Configuration */}
              <ScrollArea className="flex-1">
                <div className="px-6 pt-4 pb-6 space-y-6">
                  {/* Plan header */}
                  <div>
                    <h3 className="text-sm font-semibold leading-none">Upgrade to {selectedPlanForCheckout.name}</h3>
                    <Button
                      type="button"
                      variant="link"
                      className="text-xs text-muted-foreground underline hover:text-foreground transition-colors leading-none mt-0.5 h-auto p-0"
                      onClick={() => {
                        setViewMode('plans');
                        setSelectedPlanForCheckout(null);
                      }}
                    >
                      Change plan
                    </Button>
                  </div>

                  {/* Billing period */}
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Billing period</Label>
                    <Select value={checkoutBillingCycle} onValueChange={(v) => setCheckoutBillingCycle(v as 'monthly' | 'annually')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="annually">
                          <div className="flex items-center gap-2">
                            <span>Annually - {formatCurrency(checkoutPrices.annualPricePerSeat / 12)} / user / month</span>
                            <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400 text-xs rounded-sm">Save 17%</Badge>
                          </div>
                        </SelectItem>
                        <SelectItem value="monthly">
                          Monthly - {formatCurrency(checkoutPrices.monthlyPricePerSeat)} / user / month
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Seats */}
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Seats</Label>
                    <div className="flex items-center justify-between px-4 py-3 border rounded-lg">
                      <div>
                        <p className="text-sm font-medium">Seats</p>
                        <p className="text-sm text-muted-foreground">
                          {selectedPlanForCheckout.maxMembers != null
                            ? `Up to ${selectedPlanForCheckout.maxMembers} seats on ${selectedPlanForCheckout.name}`
                            : 'Purchase additional seats to add more users'}
                        </p>
                      </div>
                      <div className="flex items-center border rounded-md overflow-hidden">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                          onClick={() => setCheckoutSeatCount(Math.max(1, checkoutSeatCount - 1))}
                          disabled={checkoutSeatCount <= 1}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <span className="w-8 text-center text-sm font-medium">{checkoutSeatCount}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                          onClick={() => setCheckoutSeatCount(selectedPlanForCheckout.maxMembers != null ? Math.min(selectedPlanForCheckout.maxMembers, checkoutSeatCount + 1) : checkoutSeatCount + 1)}
                          disabled={selectedPlanForCheckout.maxMembers != null && checkoutSeatCount >= selectedPlanForCheckout.maxMembers}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Monthly Emails */}
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Monthly Emails</Label>
                    <div className="p-4 border rounded-lg space-y-3">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">Extra monthly emails</p>
                          <span className="text-sm font-medium">
                            {checkoutPrices.creditsPriceMonthly > 0 ? `${formatCurrency(checkoutPrices.creditsPriceMonthly)}/ month` : 'Included'}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {selectedPlanForCheckout.emailsPerMonth?.toLocaleString() || '1000'} included on {selectedPlanForCheckout.name}
                          {checkoutEmailCredits > 0 && <span className="text-blue-600"> + {(checkoutEmailCredits / 1000).toFixed(0)}k/ month</span>}
                        </p>
                      </div>

                      {/* Slider */}
                      <div className="space-y-2 pt-2">
                        <Slider
                          value={[EMAIL_CREDIT_OPTIONS.findIndex(o => o.value === checkoutEmailCredits)]}
                          min={0}
                          max={EMAIL_CREDIT_OPTIONS.length - 1}
                          step={1}
                          onValueChange={(values) => {
                            setCheckoutEmailCredits(EMAIL_CREDIT_OPTIONS[values[0]].value);
                          }}
                        />
                        <div className="relative h-5 mt-1 mx-[10px]">
                          {EMAIL_CREDIT_OPTIONS.map((option, index) => {
                            const totalStops = EMAIL_CREDIT_OPTIONS.length - 1;
                            const position = (index / totalStops) * 100;

                            return (
                              <Button
                                key={option.value}
                                type="button"
                                variant="ghost"
                                onClick={() => setCheckoutEmailCredits(option.value)}
                                className={cn(
                                  "absolute text-xs transition-colors whitespace-nowrap -translate-x-1/2 h-auto p-0",
                                  checkoutEmailCredits === option.value
                                    ? "text-primary font-medium"
                                    : "text-muted-foreground hover:text-foreground"
                                )}
                                style={{ left: `${position}%` }}
                              >
                                {option.label}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>

                </div>
              </ScrollArea>

              {/* Right side - Summary */}
              <div className="w-[344px] border-l bg-muted/30 p-6 flex flex-col">
                <div className="flex-1 space-y-4">
                  {/* Seats line item */}
                  <div className="flex justify-between text-sm">
                    <div>
                      <p>{checkoutSeatCount} seat{checkoutSeatCount !== 1 ? 's' : ''} &times; {selectedPlanForCheckout.name}</p>
                      <p className="text-muted-foreground text-xs">
                        (at {formatCurrency(checkoutPrices.pricePerSeat)} / {checkoutPrices.isAnnual ? 'year' : 'month'})
                      </p>
                    </div>
                    <span className="font-medium">{formatCurrency(checkoutPrices.seatsTotal)}</span>
                  </div>

                  {/* Email credits line item */}
                  {checkoutEmailCredits > 0 && (
                    <div className="flex justify-between text-sm">
                      <div>
                        <p>Extra emails {(checkoutEmailCredits / 1000).toFixed(0)}k</p>
                        <p className="text-muted-foreground text-xs">
                          (at {formatCurrency(checkoutPrices.creditsPrice)} / {checkoutPrices.isAnnual ? 'year' : 'month'})
                        </p>
                      </div>
                      <span className="font-medium">{formatCurrency(checkoutPrices.creditsPrice)}</span>
                    </div>
                  )}

                  <Separator />

                  <div className="flex justify-between text-sm">
                    <span>Subtotal</span>
                    <span className="font-medium">{formatCurrency(checkoutPrices.subtotal)}</span>
                  </div>

                  <div className="flex justify-between text-sm">
                    <span>Tax</span>
                    <span className="text-muted-foreground text-xs">Calculated at checkout</span>
                  </div>

                  <Separator />

                  <div className="flex justify-between text-sm">
                    <div className="flex items-center gap-1">
                      <span>Subtotal {checkoutPrices.isAnnual ? '/ year' : '/ month'}</span>
                      <TooltipProvider delayDuration={0}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3.5 w-3.5 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p className="text-xs">Final price including applicable tax will be shown at checkout</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <span className="font-semibold">{formatCurrency(checkoutPrices.subtotal)}</span>
                  </div>
                </div>

                {/* Trial note (Business only) */}
                {trialEligible && selectedPlanForCheckout.slug === 'business' && (
                  <p className="text-xs text-muted-foreground mt-4 text-center">
                    Your 14-day free trial starts today — you won&apos;t be charged until it ends.
                  </p>
                )}

                {/* Checkout button */}
                <Button
                  className={cn('w-full', trialEligible && selectedPlanForCheckout.slug === 'business' ? 'mt-2' : 'mt-6')}
                  size="lg"
                  onClick={handleCheckout}
                  disabled={!!processingPlanId || isPending}
                >
                  {processingPlanId || isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Redirecting to checkout...
                    </>
                  ) : (
                    'Continue to checkout'
                  )}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          /* Plans View */
          <ScrollArea className="max-h-[90vh]">
            <div className="p-8">
            <DialogHeader className="text-center mb-8">
              <DialogTitle className="text-xl font-medium">
                {subscription ? 'Upgrade plan' : 'Choose a plan'}
              </DialogTitle>
            </DialogHeader>

        {loading ? (
          <PageLoader fullScreen={false} />
        ) : error && displayPlans.length === 0 ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <>
            {/* Feature highlight banner with billing toggle */}
            {featureHighlight && (
              <div className="rounded-2xl border bg-card px-5 h-[53px] flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">{featureHighlight.description.split(featureHighlight.feature).map((part, i, arr) => i < arr.length - 1 ? <React.Fragment key={i}>{part}<span className="font-medium text-foreground">{featureHighlight.feature}</span></React.Fragment> : part)}</p>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium">{billingCycle === 'yearly' ? 'Annual' : 'Monthly'}</span>
                  {billingCycle === 'yearly' && <span className="text-sm font-medium text-green-600 -ml-1.5">(Save 17%)</span>}
                  <Button
                    variant="ghost"
                    onClick={() => setBillingCycle(billingCycle === 'yearly' ? 'monthly' : 'yearly')}
                    className={`relative w-8 h-5 rounded-full transition-colors p-0 ${
                      billingCycle === 'yearly' ? 'bg-foreground' : 'bg-muted-foreground/20'
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-3 h-3 bg-background rounded-full transition-transform ${
                        billingCycle === 'yearly' ? 'translate-x-3' : 'translate-x-0'
                      }`}
                    />
                  </Button>
                </div>
              </div>
            )}

            {/* Error message */}
            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Downgrade blockers */}
            {downgradeBlockers.length > 0 && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <p className="font-medium mb-2">Cannot downgrade - please reduce usage first:</p>
                  <ul className="list-disc list-inside space-y-1">
                    {downgradeBlockers.map((blocker, i) => (
                      <li key={i}>{blocker}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Plans Grid with decorative lines */}
            <div className="relative overflow-visible mt-[17px]">
              {/* Vertical lines between packages */}
              <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block -left-2 bg-border/50" style={{ maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
              {displayPlans.length === 4 && (
                <>
                  <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block bg-border/50" style={{ left: 'calc(25% - 4.5px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
                  <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block bg-border/50" style={{ left: 'calc(50% - 0.5px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
                  <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block bg-border/50" style={{ left: 'calc(75% + 3.5px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
                </>
              )}
              {displayPlans.length === 3 && (
                <>
                  <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block bg-border/50" style={{ left: 'calc(33.33% - 2px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
                  <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block bg-border/50" style={{ left: 'calc(66.66% + 1px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
                </>
              )}
              {displayPlans.length === 2 && (
                <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block bg-border/50" style={{ left: 'calc(50% - 0.5px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
              )}
              <div className="absolute -top-[9px] -bottom-[9px] w-px hidden sm:block -right-2 bg-border/50" style={{ maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />

              {/* Horizontal lines */}
              <div className="absolute -top-[9px] -left-2 -right-2 h-px hidden sm:block bg-border/50" style={{ maskImage: 'linear-gradient(to right, transparent, black 2%, black 98%, transparent)' }} />
              <div className="absolute -bottom-[9px] -left-2 -right-2 h-px hidden sm:block bg-border/50" style={{ maskImage: 'linear-gradient(to right, transparent, black 2%, black 98%, transparent)' }} />

              {/* Corner plus icons */}
              <Plus className="absolute -top-[9px] -left-2 w-3 h-3 text-border hidden sm:block -translate-x-[calc(50%-0.5px)] -translate-y-1/2 z-10" strokeWidth={3.5} />
              <Plus className="absolute -top-[9px] -right-2 w-3 h-3 text-border hidden sm:block translate-x-[calc(50%-0.5px)] -translate-y-1/2 z-10" strokeWidth={3.5} />
              <Plus className="absolute -bottom-[9px] -left-2 w-3 h-3 text-border hidden sm:block -translate-x-[calc(50%-0.5px)] translate-y-[calc(50%-0.5px)] z-10" strokeWidth={3.5} />
              <Plus className="absolute -bottom-[9px] -right-2 w-3 h-3 text-border hidden sm:block translate-x-[calc(50%-0.5px)] translate-y-[calc(50%-0.5px)] z-10" strokeWidth={3.5} />

              <div className={cn(
                'grid gap-4',
                displayPlans.length === 4 ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4' :
                displayPlans.length === 3 ? 'grid-cols-1 sm:grid-cols-3' :
                'grid-cols-1 sm:grid-cols-2'
              )}>
              {displayPlans.map((plan) => {
                const price = getPrice(plan);
                const isProcessing = processingPlanId === plan.id;
                const features = getPlanFeatures(plan);
                const highlighted = isPlanHighlighted(plan);
                const isCurrent = isPlanCurrent(plan);
                const isAnnual = billingCycle === 'yearly';

                return (
                  <div
                    key={plan.id}
                    className={`relative p-[18px] rounded-2xl flex flex-col bg-card ${
                      highlighted
                        ? 'border border-blue-200 ring-4 ring-blue-50 dark:border-blue-800 dark:ring-blue-950'
                        : 'border'
                    }`}
                  >
                    {/* Plan name */}
                    <h3 className="text-base font-medium mb-[21px]">{plan.name}</h3>

                    {/* Price */}
                    <div className="mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-3xl font-semibold">
                          {isContactPlan(plan)
                            ? 'Custom'
                            : (
                              <NumberFlow
                                value={isAnnual
                                  ? Math.round((plan.yearlyPrice || Math.round(plan.monthlyPrice * 10)) / 12) / 100
                                  : plan.monthlyPrice / 100}
                                format={{ style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 0 }}
                                transformTiming={{ duration: 400, easing: 'ease-out' }}
                              />
                            )}
                        </span>
                        {!isContactPlan(plan) && plan.monthlyPrice > 0 && isAnnual && (
                          <span className="text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 px-2 py-1 rounded-lg dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800">
                            Save 17%
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Price subtitle */}
                    <p className="text-sm text-muted-foreground mb-1">
                      {isContactPlan(plan)
                        ? 'Billed annually'
                        : (isAnnual ? 'Per user/month, billed annually' : 'Per user/month')}
                    </p>

                    {/* Trial note (Business only) */}
                    <p className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-6 h-4">
                      {plan.slug === 'business' && trialEligible && !isCurrent
                        ? '14-day free trial'
                        : ''}
                    </p>

                    {/* Description */}
                    {plan.description && (
                      <p className="text-sm font-medium mb-[10px]">{plan.description}</p>
                    )}

                    {/* Features */}
                    <div className="space-y-3 flex-1">
                      {features.map((feature, featureIndex) => (
                        <div key={featureIndex} className="flex items-start gap-2">
                          <div className="w-5 h-5 rounded-sm bg-muted flex items-center justify-center flex-shrink-0">
                            <Check className="h-3 w-3 text-muted-foreground" />
                          </div>
                          <span className="text-sm text-muted-foreground">{feature}</span>
                        </div>
                      ))}
                    </div>

                    {/* CTA Button */}
                    {isContactPlan(plan) ? (
                      <EnterpriseContactForm
                        trigger={
                          <Button
                            variant="outline"
                            className="block w-full text-center px-4 py-2.5 rounded-xl text-sm font-medium transition-colors mt-6 bg-card border hover:bg-muted disabled:opacity-50"
                            disabled={isCurrent}
                          >
                            {isCurrent ? 'Current Plan' : 'Contact sales'}
                          </Button>
                        }
                      />
                    ) : (
                      <Button
                        variant={highlighted && !isCurrent ? 'default' : 'outline'}
                        className={`block w-full text-center px-4 py-2.5 rounded-xl text-sm font-medium transition-colors mt-6 disabled:opacity-50 ${
                          highlighted && !isCurrent
                            ? 'bg-foreground text-background hover:bg-foreground/90'
                            : 'bg-card border hover:bg-muted'
                        }`}
                        disabled={isCurrent || isProcessing || isPending}
                        onClick={() => handleSelectPlan(plan)}
                      >
                        {isProcessing || (isPending && processingPlanId === plan.id) ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin inline" />
                            Processing...
                          </>
                        ) : (
                          getButtonText(plan)
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
              </div>
            </div>

          </>
        )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

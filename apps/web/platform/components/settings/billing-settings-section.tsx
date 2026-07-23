
import { useTranslations } from '@weldsuite/i18n/client';
import { useEffect, useState, memo } from 'react';
import { useSearchParams, useRouter } from '@/lib/router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Separator } from '@weldsuite/ui/components/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@weldsuite/ui/components/dialog';
import { AlertCircle, Loader2, FileText, ArrowLeft, Download, CreditCard, Check, Plus, Minus, Users, Info, X, ChevronLeft } from 'lucide-react';
import NumberFlow from '@number-flow/react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Slider } from '@weldsuite/ui/components/slider';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { PageLoader } from '@/components/page-loader';
import { cn } from '@/lib/utils';
import { EnterpriseContactForm } from '@/components/billing/enterprise-contact-form';
import { Billing } from '@/lib/api/types/apps/billing.types';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  usePlanLimits,
  useInvoices,
  useChangePlan,
  useCancelSubscription,
  useUpdateSeats,
  billingKeys,
} from '@/hooks/queries/use-billing-queries';
import { useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { BillingInvoiceResponse } from '@/lib/api/domains/billing';

type InvoiceInfo = BillingInvoiceResponse;

type ViewMode = 'overview' | 'plans' | 'invoices' | 'invoice-detail';

// Curated feature lists per plan
const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    'Up to 2 users',
    '100 credits included',
    '1,000 emails per month',
    'All apps included',
    'Unlimited contacts',
    'Two-factor authentication',
  ],
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

function formatPlanFeatures(plan: Billing.BillingPlan): string[] {
  const key = plan.name.toLowerCase();
  return PLAN_FEATURES[key] || [];
}

// Helper to format price from cents
function formatPlanPrice(cents: number, currency: string = 'USD'): string {
  if (cents === 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

// Monthly email credit options
const EMAIL_CREDIT_OPTIONS = [
  { value: 0, label: '0' },
  { value: 10000, label: '10k' },
  { value: 25000, label: '25k' },
  { value: 50000, label: '50k' },
  { value: 100000, label: '100k' },
  { value: 250000, label: '250k' },
  { value: 500000, label: '500k' },
  { value: 1000000, label: '1M' },
];

// Price per credit: $0.0012 = 0.12 cents
const PRICE_PER_CREDIT_CENTS = 0.12;

const getEmailPrice = (_planName: string, creditCount: number): number => {
  if (creditCount <= 0) return 0;
  return Math.round(creditCount * PRICE_PER_CREDIT_CENTS);
};

// Feature comparison table data (matching weldsuite.org/pricing)
type ComparisonRow = { label: string; indent?: boolean; values: Record<string, string | boolean> };
type ComparisonSection = { title: string; rows: ComparisonRow[] };

const COMPARISON_SECTIONS: ComparisonSection[] = [
  {
    title: 'Platform & Workspace',
    rows: [
      { label: 'Seat limit', values: { free: 'Up to 2', business: '3–25', scale: 'Unlimited', enterprise: 'Custom' } },
      { label: 'Remove branding', indent: true, values: { free: false, business: true, scale: true, enterprise: true } },
      { label: 'Priority support', indent: true, values: { free: false, business: false, scale: true, enterprise: true } },
      { label: 'Dedicated support', indent: true, values: { free: false, business: false, scale: false, enterprise: true } },
      { label: 'API access', indent: true, values: { free: false, business: true, scale: true, enterprise: true } },
      { label: 'SSO / SAML', indent: true, values: { free: false, business: false, scale: false, enterprise: true } },
      { label: 'Custom integrations', indent: true, values: { free: false, business: false, scale: false, enterprise: true } },
      { label: 'Roles & permissions', indent: true, values: { free: false, business: true, scale: true, enterprise: true } },
      { label: 'Activity log', indent: true, values: { free: false, business: false, scale: true, enterprise: true } },
      { label: 'Two-factor authentication', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'Automations',
    rows: [
      { label: 'Credits included', values: { free: '100', business: '1,000', scale: '2,500', enterprise: 'Custom' } },
      { label: 'Emails per month', values: { free: '1,000', business: '10,000', scale: '25,000', enterprise: 'Custom' } },
      { label: 'Integration blocks', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Email sequences', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Workflow automations', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'CRM',
    rows: [
      { label: 'Customer management (B2B/B2C)', values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Contacts', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'Leads', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Opportunities', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Sales pipelines', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'Activities', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Customer lists', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'Import / export', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Tags & custom fields', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Call intelligence', indent: true, values: { free: false, business: false, scale: true, enterprise: true } },
      { label: 'Meeting intelligence', indent: true, values: { free: false, business: false, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'Helpdesk (WeldDesk)',
    rows: [
      { label: 'Tickets', values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Live chat', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Email channel', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Knowledge base', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Canned responses', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Departments', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'Agents', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'SLA management', indent: true, values: { free: false, business: false, scale: true, enterprise: true } },
      { label: 'Customer reviews', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Multi-channel (Discord / Slack)', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Analytics', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'WeldAgent AI', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'Mail (WeldMail)',
    rows: [
      { label: 'Custom email domain', indent: true, values: { free: false, business: true, scale: true, enterprise: true } },
      { label: 'Email accounts', values: { free: '2', business: '10', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'Email domains', values: { free: '0', business: '1', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'Templates', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Rules & filters', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Labels & folders', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Drafts & scheduled send', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Snooze', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'AI smart replies', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'AI summaries', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Contacts integration', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Attachments', values: { free: '25MB', business: '25MB', scale: '25MB', enterprise: 'Custom' } },
    ],
  },
  {
    title: 'Projects (WeldFlow)',
    rows: [
      { label: 'Projects', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'Tasks & subtasks', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Kanban boards', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Gantt charts', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Timeline view', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Calendar view', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Table view', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Workload view', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Time tracking', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Milestones', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Goals & OKRs', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Documents', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Files', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Messages', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Whiteboard', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Analytics', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'Task Automation (WeldConnect)',
    rows: [
      { label: 'Visual workflow builder', values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Templates', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Cron triggers', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Entity triggers', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Variables', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Integrations marketplace', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Execution history', values: { free: '7 days', business: '30 days', scale: '90 days', enterprise: 'Unlimited' } },
      { label: 'Error handling & retries', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Workflow chaining', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Analytics', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'Host (WeldHost)',
    rows: [
      { label: 'Domain registration', values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'External domains', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'DNS zones', values: { free: 'Unlimited', business: 'Unlimited', scale: 'Unlimited', enterprise: 'Unlimited' } },
      { label: 'DNS records', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Domain transfers', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'SSL certificates', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Auto-renewal', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'WHOIS privacy', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'Mobile App',
    rows: [
      { label: 'iOS & Android', values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'CRM mobile', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Helpdesk mobile', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Mail mobile', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Projects mobile', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Push notifications', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
  {
    title: 'Communication & Real-time',
    rows: [
      { label: 'Real-time messaging', values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Typing indicators', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Presence status', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'In-app notifications', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Email notifications', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
      { label: 'Push notifications', indent: true, values: { free: true, business: true, scale: true, enterprise: true } },
    ],
  },
];

// WeldSuite apps included in plans (same logos/sizes as global sidebar)
const includedApps = [
  { id: 'crm', name: 'WeldCRM', logo: '/assets/images/weldcrm/logo-light.png', logoClass: 'h-4 w-4' },
  { id: 'mail', name: 'WeldMail', logo: '/assets/images/weldmail/logo-light.png', logoClass: 'h-4 w-4' },
  { id: 'helpdesk', name: 'WeldDesk', logo: '/assets/images/welddesk/logo-light.png', logoClass: 'h-4 w-4' },
  { id: 'projects', name: 'WeldFlow', logo: '/assets/images/weldflow/logo-light.png', logoClass: 'h-[18px] w-[18px]' },
  { id: 'task', name: 'WeldConnect', logo: '/assets/images/weldconnect/logo-light.png', logoClass: 'h-[17px] w-[17px]' },
  { id: 'host', name: 'WeldHost', logo: '/assets/images/weldhost/logo-light.png', logoClass: 'h-[17px] w-[17px]' },
];

// Extracted checkout dialog to prevent re-renders of the massive comparison table
const CheckoutDialog = memo(function CheckoutDialog({
  selectedPlan,
  onClose,
  minSeats,
  onConfirmCheckout,
  processing,
}: {
  selectedPlan: Billing.BillingPlan | null;
  onClose: () => void;
  minSeats: number;
  onConfirmCheckout: (plan: Billing.BillingPlan, seats: number, billingCycle: 'monthly' | 'annually') => void;
  processing: boolean;
}) {
  const [seatCount, setSeatCount] = useState(1);
  const [emailCredits, setEmailCredits] = useState(0);
  const [sliderIndex, setSliderIndex] = useState(0);
  const [checkoutBillingCycle, setCheckoutBillingCycle] = useState<'monthly' | 'annually'>('annually');
  const t = useTranslations();

  // Reset state when plan changes
  useEffect(() => {
    if (selectedPlan) {
      setSeatCount(Math.min(Math.max(1, minSeats), selectedPlan.maxMembers ?? Infinity));
      setEmailCredits(0);
      setSliderIndex(0);
      setCheckoutBillingCycle('annually');
    }
  }, [selectedPlan, minSeats]);

  if (!selectedPlan) return null;

  const exceedsMaxMembers = selectedPlan.maxMembers != null && minSeats > selectedPlan.maxMembers;

  const isBillingAnnual = checkoutBillingCycle === 'annually';
  const monthlyPricePerSeat = selectedPlan.monthlyPrice;
  const annualPricePerSeat = selectedPlan.yearlyPrice || Math.round(selectedPlan.monthlyPrice * 10);
  const pricePerSeat = isBillingAnnual ? annualPricePerSeat : monthlyPricePerSeat;
  const creditsPriceMonthly = getEmailPrice(selectedPlan.name, emailCredits);
  const creditsPrice = isBillingAnnual ? creditsPriceMonthly * 12 : creditsPriceMonthly;
  const seatsTotal = pricePerSeat * seatCount;
  const subtotal = seatsTotal + creditsPrice;

  return (
    <Dialog open={!!selectedPlan} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[840px] h-[600px] p-0 overflow-hidden gap-0 flex flex-col" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center px-4 h-[55px] border-b shrink-0">
          <h2 className="text-sm font-semibold flex-1">{t('sweep.settings.billing.checkout.title')}</h2>
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left side - Configuration */}
          <ScrollArea className="flex-1">
            <div className="p-6 space-y-6">
              {/* Plan header */}
              <div>
                <h3 className="text-sm font-semibold leading-none">{t('sweep.settings.billing.checkout.upgradeTo', { name: selectedPlan.name })}</h3>
                <Button
                  type="button"
                  variant="link"
                  className="text-xs text-muted-foreground underline hover:text-foreground transition-colors leading-none mt-0.5 p-0 h-auto"
                  onClick={onClose}
                >
                  {t('settings.billing.changePlan')}
                </Button>
              </div>

              {/* Billing period */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">{t('sweep.settings.billing.checkout.billingPeriod')}</Label>
                <Select value={checkoutBillingCycle} onValueChange={(v) => setCheckoutBillingCycle(v as 'monthly' | 'annually')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    <SelectItem value="annually">
                      <div className="flex items-center gap-2">
                        <span>{t('sweep.settings.billing.checkout.annuallyPrice', { price: formatPlanPrice(Math.round(annualPricePerSeat / 12)) })}</span>
                        <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400 text-xs rounded-sm">{t('sweep.settings.billing.save17')}</Badge>
                      </div>
                    </SelectItem>
                    <SelectItem value="monthly">
                      {t('sweep.settings.billing.checkout.monthlyPrice', { price: formatPlanPrice(monthlyPricePerSeat) })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Seats */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">{t('sweep.settings.billing.seats')}</Label>
                <div className="flex items-center justify-between px-4 py-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{t('sweep.settings.billing.seats')}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedPlan.maxMembers != null
                        ? t('sweep.settings.billing.checkout.upToSeatsOnPlan', { max: selectedPlan.maxMembers, name: selectedPlan.name })
                        : t('sweep.settings.billing.checkout.purchaseAdditionalSeats')}
                    </p>
                  </div>
                  <div className="flex items-center border rounded-md overflow-hidden">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                      onClick={() => setSeatCount(Math.max(minSeats, seatCount - 1))}
                      disabled={seatCount <= minSeats}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <span className="w-8 text-center text-sm font-medium">{seatCount}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                      onClick={() => setSeatCount(selectedPlan.maxMembers != null ? Math.min(selectedPlan.maxMembers, seatCount + 1) : seatCount + 1)}
                      disabled={selectedPlan.maxMembers != null && seatCount >= selectedPlan.maxMembers}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Monthly Emails */}
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">{t('sweep.settings.billing.checkout.monthlyEmails')}</Label>
                <div className="p-4 border rounded-lg space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">{t('sweep.settings.billing.checkout.extraMonthlyEmails')}</p>
                      <span className="text-sm font-medium">
                        {creditsPriceMonthly > 0 ? `${formatPlanPrice(creditsPriceMonthly)}/${t('sweep.settings.billing.month')}` : t('sweep.settings.billing.checkout.included')}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {t('sweep.settings.billing.checkout.emailsIncludedOnPlan', { count: selectedPlan.emailsPerMonth?.toLocaleString() || '1,000', name: selectedPlan.name })}
                      {emailCredits > 0 && <span className="text-blue-600 dark:text-blue-400"> + {(emailCredits / 1000).toFixed(0)}k/{t('sweep.settings.billing.month')}</span>}
                    </p>
                  </div>

                  {/* Slider */}
                  <div className="space-y-2 pt-2">
                    <Slider
                      value={[sliderIndex]}
                      min={0}
                      max={EMAIL_CREDIT_OPTIONS.length - 1}
                      step={1}
                      onValueChange={(values) => {
                        setSliderIndex(values[0]);
                        setEmailCredits(EMAIL_CREDIT_OPTIONS[values[0]].value);
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
                            onClick={() => { setSliderIndex(index); setEmailCredits(option.value); }}
                            className={cn(
                              "absolute text-xs transition-colors whitespace-nowrap -translate-x-1/2 h-auto p-0",
                              emailCredits === option.value
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
                  <p>{t('sweep.settings.billing.checkout.seatsLine', { count: seatCount, name: selectedPlan.name })}</p>
                  <p className="text-muted-foreground text-xs">
                    ({t('sweep.settings.billing.checkout.atPricePerCycle', { price: formatPlanPrice(pricePerSeat), cycle: isBillingAnnual ? t('sweep.settings.billing.year') : t('sweep.settings.billing.month') })})
                  </p>
                </div>
                <span className="font-medium">{formatPlanPrice(seatsTotal)}</span>
              </div>

              {/* Email credits line item */}
              {emailCredits > 0 && (
                <div className="flex justify-between text-sm">
                  <div>
                    <p>{t('sweep.settings.billing.checkout.extraEmailsLine', { count: (emailCredits / 1000).toFixed(0) })}</p>
                    <p className="text-muted-foreground text-xs">
                      ({t('sweep.settings.billing.checkout.atPricePerCycle', { price: formatPlanPrice(creditsPrice), cycle: isBillingAnnual ? t('sweep.settings.billing.year') : t('sweep.settings.billing.month') })})
                    </p>
                  </div>
                  <span className="font-medium">{formatPlanPrice(creditsPrice)}</span>
                </div>
              )}

              <Separator />

              <div className="flex justify-between text-sm">
                <span>{t('sweep.settings.billing.subtotal')}</span>
                <span className="font-medium">{formatPlanPrice(subtotal)}</span>
              </div>

              <div className="flex justify-between text-sm">
                <span>{t('sweep.settings.billing.tax')}</span>
                <span className="text-muted-foreground text-xs">{t('sweep.settings.billing.checkout.calculatedAtCheckout')}</span>
              </div>

              <Separator />

              <div className="flex justify-between text-sm">
                <div className="flex items-center gap-1">
                  <span>{t('sweep.settings.billing.subtotal')} {isBillingAnnual ? `/ ${t('sweep.settings.billing.year')}` : `/ ${t('sweep.settings.billing.month')}`}</span>
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p className="text-xs">{t('sweep.settings.billing.checkout.finalPriceNotice')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <span className="font-semibold">{formatPlanPrice(subtotal)}</span>
              </div>
            </div>

            {/* Warning when current members exceed target plan's max */}
            {exceedsMaxMembers && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {t('sweep.settings.billing.checkout.exceedsMaxMembers', { count: minSeats, name: selectedPlan.name, max: selectedPlan.maxMembers, removeCount: minSeats - (selectedPlan.maxMembers ?? 0) })}
                </AlertDescription>
              </Alert>
            )}

            {/* Checkout button */}
            <Button
              className="w-full mt-6"
              size="lg"
              onClick={() => onConfirmCheckout(selectedPlan, seatCount, checkoutBillingCycle)}
              disabled={processing || exceedsMaxMembers}
            >
              {processing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('sweep.settings.billing.checkout.redirecting')}</>
              ) : (
                t('sweep.settings.billing.checkout.continueToCheckout')
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export function BillingSettingsSection() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  const [viewMode, setViewMode] = useState<ViewMode>('plans');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<Billing.Subscription | null>(null);
  const [plans, setPlans] = useState<Billing.BillingPlan[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceInfo | null>(null);
  const [processing, setProcessing] = useState(false);
  const [downgradeBlockers, setDowngradeBlockers] = useState<string[]>([]);
  const [isAnnual, setIsAnnual] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<Billing.BillingPlan | null>(null);
  const [manageSeatsOpen, setManageSeatsOpen] = useState(false);
  const [manageSeatCount, setManageSeatCount] = useState(1);
  const [invoiceLimit, setInvoiceLimit] = useState(10);

  // React Query hooks
  const { data: limitsData } = usePlanLimits();
  const { data: invoicesData } = useInvoices(invoiceLimit);
  const changePlanMutation = useChangePlan();
  const cancelMutation = useCancelSubscription();
  const updateSeatsMutation = useUpdateSeats();

  const planLimits = (limitsData as any)?.data as Billing.PlanLimits | null ?? null;
  const invoices = ((invoicesData as any)?.data as InvoiceInfo[]) ?? [];

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);

    try {
      const client = await getClient();
      // app-api GET /api/billing/plans-page — `{ data }` envelope; failures throw.
      const plansResult = await client.get<{
        data?: { plans: Billing.BillingPlan[]; subscription: Billing.Subscription | null };
      }>('/billing/plans-page');
      if (plansResult.data) {
        setPlans((plansResult.data.plans || []).map(p => ({
          ...p,
          highlighted: p.highlighted || p.slug === 'scale',
        })));
        setSubscription(plansResult.data.subscription);
        setError(null);

        // Plan limits and invoices are now loaded via React Query hooks

        // Always show plans view
        setViewMode('plans');
      } else {
        // On error, show plans view
        setViewMode('plans');
        loadPlans();
      }
    } catch (err) {
      setViewMode('plans');
      loadPlans();
    }

    setLoading(false);
  };

  const loadPlans = async () => {
    try {
      const client = await getClient();
      // app-api GET /api/billing/plans-page — `{ data }` envelope.
      const plansResult = await client.get<{
        data?: { plans: Billing.BillingPlan[]; subscription: Billing.Subscription | null };
      }>('/billing/plans-page');

      if (plansResult.data) {
        setPlans((plansResult.data.plans || []).map(p => ({
          ...p,
          highlighted: p.highlighted || p.slug === 'scale',
        })));
        if (plansResult.data.subscription) {
          setSubscription(plansResult.data.subscription);
        }
      }
    } catch (err) {
      console.error('Error loading plans:', err);
    }
    // Plan limits loaded via React Query hook
    setDowngradeBlockers([]);
  };

  const refreshBillingData = () => {
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
  };

  const handleUpgrade = () => {
    setViewMode('plans');
    loadPlans();
  };

  const handleChangePlan = () => {
    setViewMode('plans');
    loadPlans();
  };

  const handleCancel = async () => {
    if (confirm(t('settings.billing.cancelConfirm'))) {
      try {
        await cancelMutation.mutateAsync();
        toast.success(t('sweep.settings.billing.messages.cancelSuccess'));
        await loadData();
      } catch (err: any) {
        setError(err?.message || t('sweep.settings.billing.messages.cancelFailed'));
      }
    }
  };

  const handleSelectPlan = (plan: Billing.BillingPlan) => {
    // Enterprise requires contact
    if (plan.requiresContact) {
      window.open('mailto:sales@weldsuite.com?subject=Enterprise%20Plan%20Inquiry', '_blank');
      return;
    }

    // Free plans — proceed directly without seat selection
    if (plan.monthlyPrice === 0) {
      handleConfirmCheckout(plan, 1);
      return;
    }

    // Paid plans — open checkout dialog
    setSelectedPlan(plan);
  };

  const handleConfirmCheckout = async (plan: Billing.BillingPlan, seats: number, billingCycle: 'monthly' | 'annually' = 'annually') => {
    setProcessing(true);
    setError(null);
    setDowngradeBlockers([]);

    const currentPlan = plans.find(p => p.id === subscription?.planId);

    // Check if this is a downgrade or if the target plan has a lower seat limit than current members
    const isDowngrade = currentPlan && plan.monthlyPrice < currentPlan.monthlyPrice;
    const needsValidation = isDowngrade || (plan.maxMembers != null && (planLimits?.currentUsage.memberCount ?? 0) > plan.maxMembers);

    // Validate downgrade / seat limit before proceeding
    if (needsValidation) {
      const client = await getClient();
      // app-api POST /api/billing/validate-downgrade — `{ data }` envelope.
      const validationResult = await client.post<{
        data?: { canDowngrade: boolean; blockers: string[] };
      }>(`/billing/validate-downgrade`, { planId: plan.id });
      if (validationResult.data) {
        if (!validationResult.data.canDowngrade) {
          setDowngradeBlockers(validationResult.data.blockers);
          setProcessing(false);
          setSelectedPlan(null);
          return;
        }
      } else {
        setError(t('sweep.settings.billing.errors.validateDowngradeFailed'));
        setProcessing(false);
        setSelectedPlan(null);
        return;
      }
    }

    // Create Stripe Checkout session via billing worker
    try {
      const result = await changePlanMutation.mutateAsync({
        planId: plan.id,
        seats: seats,
        cycle: billingCycle === 'annually' ? 'yearly' : 'monthly',
      });

      if ((result as any).url) {
        // Redirect to Stripe Checkout
        window.location.href = (result as any).url;
        return;
      } else if (result.success) {
        // Free plan change (no checkout needed)
        toast.success(t('sweep.settings.billing.toasts.planChanged', { name: plan.name }));
        await loadData();
        setError(null);
      } else {
        setError(t('sweep.settings.billing.errors.changePlanFailed'));
      }
    } catch (err: any) {
      setError(err?.message || t('sweep.settings.billing.errors.changePlanFailed'));
    }
    setProcessing(false);
    setSelectedPlan(null);
  };

  const handleOpenManageSeats = () => {
    setManageSeatCount(subscription?.purchasedSeats || planLimits?.currentUsage.memberCount || 1);
    setManageSeatsOpen(true);
  };

  const handleConfirmUpdateSeats = async () => {
    setProcessing(true);
    setError(null);

    try {
      const result = await updateSeatsMutation.mutateAsync({ seats: manageSeatCount });
      if (result.success && (result as any).paymentUrl) {
        // Redirect to Stripe hosted invoice page for payment
        window.location.href = (result as any).paymentUrl;
        return;
      } else if (result.success) {
        toast.success(t('sweep.settings.billing.toasts.seatsUpdated', { count: manageSeatCount }));
        setManageSeatsOpen(false);
        await loadData();
      } else {
        setError(t('sweep.settings.billing.errors.updateSeatsFailed'));
      }
    } catch (err: any) {
      setError(err?.message || t('sweep.settings.billing.errors.updateSeatsFailed'));
    }
    setProcessing(false);
  };

  const handleViewAllInvoices = () => {
    setViewMode('invoices');
    setInvoiceLimit(50);
  };

  const handleViewInvoice = (invoice: InvoiceInfo) => {
    setSelectedInvoice(invoice);
    setViewMode('invoice-detail');
  };

  const handleBackToOverview = () => {
    setViewMode('overview');
    setSelectedInvoice(null);
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(cents / 100);
  };

  const formatDate = (date: Date | string) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return format(dateObj, 'MMM dd, yyyy');
  };

  // The plans-page subscription reports the raw Stripe status; during a trial
  // it is 'trialing' and currentPeriodEnd marks the trial end date.
  const isTrialing = String(subscription?.status ?? '').toLowerCase() === 'trialing';
  const trialEndsAt = subscription?.currentPeriodEnd ?? null;

  // Eligible for a 14-day trial only with no subscription or on the retired
  // free plan — mirrors the backend /checkout rule.
  const trialEligible = !subscription || subscription.planSlug === 'free';

  const getInvoiceStatusBadge = (status: string) => {
    if (status === 'paid' || status === 'succeeded') {
      return (
        <Badge variant="default" className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400">
          {t('settings.billing.paid')}
        </Badge>
      );
    }
    if (status === 'pending') {
      return <Badge variant="secondary">{t('sweep.settings.billing.status.pending')}</Badge>;
    }
    if (status === 'failed') {
      return <Badge variant="destructive">{t('sweep.settings.billing.status.failed')}</Badge>;
    }
    return <Badge variant="outline">{status}</Badge>;
  };

  if (loading) {
    return <PageLoader fullScreen={false} />;
  }

  if (error && !subscription && viewMode !== 'plans') {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  // Plans View
  if (viewMode === 'plans') {
    const currentApiPlan = plans.find(p => p.id === subscription?.planId);

    const isContactPlan = (plan: Billing.BillingPlan) =>
      plan.requiresContact || plan.name.toLowerCase() === 'enterprise';

    const getButtonText = (plan: Billing.BillingPlan) => {
      if (currentApiPlan?.id === plan.id) return t('settings.billing.currentPlan');
      if (trialEligible && plan.slug === 'business') return t('sweep.settings.billing.start14DayTrial');
      if (!currentApiPlan) return t('sweep.settings.billing.getStarted');
      if (plan.monthlyPrice < currentApiPlan.monthlyPrice) return t('sweep.settings.billing.downgrade');
      if (plan.monthlyPrice > currentApiPlan.monthlyPrice) return t('sweep.settings.billing.upgrade');
      return t('sweep.settings.billing.getStarted');
    };

    const isPlanCurrent = (plan: Billing.BillingPlan) => {
      return currentApiPlan?.id === plan.id;
    };

    const minSeats = Math.max(1, planLimits?.currentUsage.memberCount || 1);

    return (
      <div className="max-w-5xl mx-auto overflow-visible space-y-8">
        {/* Checkout Dialog */}
        <CheckoutDialog
          selectedPlan={selectedPlan}
          onClose={() => setSelectedPlan(null)}
          minSeats={minSeats}
          onConfirmCheckout={handleConfirmCheckout}
          processing={processing}
        />

        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.billing.plansTitle')}</h1>
          <p className="text-muted-foreground">{t('sweep.settings.billing.plansDescription')}</p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Downgrade Blockers */}
        {downgradeBlockers.length > 0 && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <div className="space-y-2">
                <p className="font-medium">{t('sweep.settings.billing.downgradeBlockersTitle')}</p>
                <ul className="list-disc list-inside space-y-1">
                  {downgradeBlockers.map((blocker, idx) => (
                    <li key={idx}>{blocker}</li>
                  ))}
                </ul>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Pricing Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-[18px] h-[53px] px-4 md:px-5 bg-card rounded-2xl border">
          {/* App icons */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">{t('sweep.settings.billing.appsIncluded')}</span>
            <div className="flex items-center gap-1.5">
              {includedApps.map((app) => (
                <div
                  key={app.id}
                  className="relative group"
                >
                  <div className="w-8 h-8 flex items-center justify-center border rounded-[10px] bg-card hover:border-muted-foreground/30 transition-colors cursor-pointer">
                    <img
                      src={app.logo}
                      alt={app.name}
                      className={`${app.logoClass} object-contain`}
                    />
                  </div>
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-10">
                    <div className="bg-foreground text-background text-xs rounded-lg py-2 px-3 whitespace-nowrap">
                      <div className="font-medium">{app.name}</div>
                    </div>
                    <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-foreground" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Annual/Monthly toggle */}
          <div className="flex items-center gap-3 w-full md:w-auto">
            <span className="text-sm font-medium">{isAnnual ? t('sweep.settings.billing.annual') : t('sweep.settings.billing.monthly')}</span>
            {isAnnual && <span className="text-sm font-medium text-green-600 -ml-1.5">({t('sweep.settings.billing.save17')})</span>}
            <Button
              variant="ghost"
              onClick={() => setIsAnnual(!isAnnual)}
              className={`relative w-8 h-5 rounded-full transition-colors p-0 ${
                isAnnual ? 'bg-foreground' : 'bg-muted-foreground/20'
              }`}
            >
              <span
                className={`absolute top-1 left-1 w-3 h-3 bg-background rounded-full transition-transform ${
                  isAnnual ? 'translate-x-3' : 'translate-x-0'
                }`}
              />
            </Button>
          </div>
        </div>

        {/* Pricing Cards with decorative lines */}
        <div className="relative overflow-visible">
          {/* Vertical lines between packages */}
          <div className="absolute -top-[9px] -bottom-[9px] w-px hidden lg:block -left-2 bg-border/50" style={{ maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
          <div className="absolute -top-[9px] -bottom-[9px] w-px hidden lg:block bg-border/50" style={{ left: 'calc(25% - 4.5px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
          <div className="absolute -top-[9px] -bottom-[9px] w-px hidden lg:block bg-border/50" style={{ left: 'calc(50% - 0.5px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
          <div className="absolute -top-[9px] -bottom-[9px] w-px hidden lg:block bg-border/50" style={{ left: 'calc(75% + 3.5px)', maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />
          <div className="absolute -top-[9px] -bottom-[9px] w-px hidden lg:block -right-2 bg-border/50" style={{ maskImage: 'linear-gradient(to bottom, transparent, black 5%, black 95%, transparent)' }} />

          {/* Horizontal lines */}
          <div className="absolute -top-[9px] -left-2 -right-2 h-px hidden lg:block bg-border/50" style={{ maskImage: 'linear-gradient(to right, transparent, black 2%, black 98%, transparent)' }} />
          <div className="absolute -bottom-[9px] -left-2 -right-2 h-px hidden lg:block bg-border/50" style={{ maskImage: 'linear-gradient(to right, transparent, black 2%, black 98%, transparent)' }} />

          {/* Corner plus icons */}
          <Plus className="absolute -top-[9px] -left-2 w-3 h-3 text-border hidden lg:block -translate-x-[calc(50%-0.5px)] -translate-y-1/2 z-10" strokeWidth={3.5} />
          <Plus className="absolute -top-[9px] -right-2 w-3 h-3 text-border hidden lg:block translate-x-[calc(50%-0.5px)] -translate-y-1/2 z-10" strokeWidth={3.5} />
          <Plus className="absolute -bottom-[9px] -left-2 w-3 h-3 text-border hidden lg:block -translate-x-[calc(50%-0.5px)] translate-y-[calc(50%-0.5px)] z-10" strokeWidth={3.5} />
          <Plus className="absolute -bottom-[9px] -right-2 w-3 h-3 text-border hidden lg:block translate-x-[calc(50%-0.5px)] translate-y-[calc(50%-0.5px)] z-10" strokeWidth={3.5} />

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {plans.map((plan) => {
            const isCurrent = isPlanCurrent(plan);
            const buttonText = getButtonText(plan);
            const features = formatPlanFeatures(plan);

            return (
              <div
                key={plan.id}
                className={`relative p-[18px] rounded-2xl flex flex-col bg-card ${
                  plan.highlighted
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
                        ? t('sweep.settings.billing.custom')
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
                        {t('sweep.settings.billing.save17')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Price subtitle */}
                <p className="text-sm text-muted-foreground mb-1">
                  {isContactPlan(plan)
                    ? t('sweep.settings.billing.billedAnnually')
                    : (isAnnual ? t('sweep.settings.billing.perUserMonthBilledAnnually') : t('sweep.settings.billing.perUserMonth'))}
                </p>

                {/* Trial note (Business only) */}
                <p className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-6 h-4">
                  {plan.slug === 'business' && trialEligible && !isPlanCurrent(plan)
                    ? t('sweep.settings.billing.trialNote14Day')
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
                        variant="ghost"
                        className="block w-full text-center px-4 py-2.5 rounded-xl text-sm font-medium transition-colors mt-6 bg-card border hover:bg-muted disabled:opacity-50"
                        disabled={isCurrent}
                      >
                        {isCurrent ? t('settings.billing.currentPlan') : t('sweep.settings.billing.contactSales')}
                      </Button>
                    }
                  />
                ) : (
                  <Button
                    variant="ghost"
                    className={`block w-full text-center px-4 py-2.5 rounded-xl text-sm font-medium transition-colors mt-6 disabled:opacity-50 ${
                      plan.highlighted
                        ? 'bg-foreground text-background hover:bg-foreground/90'
                        : 'bg-card border hover:bg-muted'
                    }`}
                    disabled={isCurrent || processing}
                    onClick={() => handleSelectPlan(plan)}
                  >
                    {processing && <Loader2 className="h-4 w-4 mr-2 animate-spin inline" />}
                    {buttonText}
                  </Button>
                )}
              </div>
            );
          })}
          </div>
        </div>

        {/* Pricing Comparison Table - hidden on mobile */}
        {plans.length > 0 && (
        <div className="hidden md:block mt-52">
          {/* Sticky Table Header */}
          <div className="sticky top-0 z-40 bg-background pt-8 pb-8 border-b">
            <div className="grid gap-0" style={{ gridTemplateColumns: `1fr repeat(${plans.length}, 1fr)` }}>
              {/* Billing toggle */}
              <div className="flex flex-col justify-end">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground">{t('sweep.settings.billing.annual')}</span>
                  <span className="text-sm font-medium text-green-600">({t('sweep.settings.billing.save17')})</span>
                  <Button
                    variant="ghost"
                    onClick={() => setIsAnnual(!isAnnual)}
                    className={`relative w-8 h-5 rounded-full transition-colors p-0 ${
                      isAnnual ? 'bg-foreground' : 'bg-muted-foreground/20'
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-3 h-3 bg-background rounded-full transition-transform ${
                        isAnnual ? 'translate-x-3' : 'translate-x-0'
                      }`}
                    />
                  </Button>
                </div>
              </div>

              {/* Plan columns */}
              {plans.map((plan, index) => (
                <div key={plan.id} className={index === plans.length - 1 ? 'pl-4 pr-0' : 'px-4'}>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-semibold">{plan.name}</h3>
                    {plan.badge && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-md dark:bg-blue-950 dark:text-blue-400">
                        {plan.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {isContactPlan(plan) ? (
                      <>{t('sweep.settings.billing.customQuoteLine1')}<br />{t('sweep.settings.billing.customQuoteLine2')}</>
                    ) : (
                      <>
                        {formatPlanPrice(isAnnual ? Math.round((plan.yearlyPrice || Math.round(plan.monthlyPrice * 10)) / 12) : plan.monthlyPrice, 'USD')} {t('sweep.settings.billing.perUserMonthComma')}<br />
                        {isAnnual ? t('sweep.settings.billing.billedAnnuallyLower') : t('sweep.settings.billing.billedMonthlyLower')}
                      </>
                    )}
                  </p>
                  {isContactPlan(plan) ? (
                    <EnterpriseContactForm
                      trigger={
                        <Button variant="outline" className="mt-4 w-full rounded-lg">
                          {t('sweep.settings.billing.talkToSales')}
                        </Button>
                      }
                    />
                  ) : (
                    <Button
                      variant={plan.highlighted ? 'default' : 'outline'}
                      className={`mt-4 w-full rounded-lg ${plan.highlighted ? 'bg-foreground hover:bg-foreground/90 text-background' : ''}`}
                      disabled={isPlanCurrent(plan) || processing}
                      onClick={() => handleSelectPlan(plan)}
                    >
                      {isPlanCurrent(plan) ? t('settings.billing.currentPlan') : getButtonText(plan)}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Comparison sections rendered from data */}
          {COMPARISON_SECTIONS.map((section) => (
            <div key={section.title} className="mt-10">
              <h4 className="text-lg font-semibold pb-4 border-b border-border/50">{section.title}</h4>
              {section.rows.map((row) => (
                <div key={row.label} className="grid gap-0 py-4 border-b border-border/50" style={{ gridTemplateColumns: `1fr repeat(${plans.length}, 1fr)` }}>
                  <div className={`flex items-center gap-2 text-sm ${row.indent ? 'text-muted-foreground pl-4' : 'font-medium'}`}>{row.label}</div>
                  {plans.map((plan, index) => {
                    const key = plan.name.toLowerCase();
                    const val = row.values[key] ?? '';
                    return (
                      <div
                        key={plan.id}
                        className={`text-center text-sm ${
                          plan.highlighted ? 'bg-blue-50 dark:bg-blue-950/30 py-4 -my-4 flex items-center justify-center' : ''
                        } ${index === plans.length - 1 ? 'pl-4 pr-0' : 'px-4'}`}
                      >
                        {val === true ? (
                          <Check className="w-4 h-4 text-primary mx-auto" />
                        ) : val === false ? (
                          <span className="text-muted-foreground/40">{'\u2715'}</span>
                        ) : (
                          <span className="text-muted-foreground">{val}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
        )}

      </div>
    );
  }

  // Invoices List View
  if (viewMode === 'invoices') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleBackToOverview}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('sweep.settings.billing.back')}
          </Button>
        </div>

        <div>
          <h3 className="text-lg font-semibold">{t('sweep.settings.billing.invoicesTitle')}</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {t('sweep.settings.billing.invoicesSubtitle')}
          </p>
        </div>

        <Card>
          <CardContent className="p-0">
            {invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {t('settings.billing.noInvoices')}
              </p>
            ) : (
              <div className="divide-y">
                {invoices.map((invoice) => (
                  <div
                    key={invoice.id}
                    className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => handleViewInvoice(invoice)}
                  >
                    <div className="flex items-center gap-4">
                      <div className="rounded-full bg-primary/10 p-2">
                        <FileText className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{invoice.id}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(invoice.periodStart)} - {formatDate(invoice.periodEnd)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-sm font-semibold">{formatCurrency(invoice.amount)}</p>
                        <div className="mt-1">{getInvoiceStatusBadge(invoice.status)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Invoice Detail View
  if (viewMode === 'invoice-detail' && selectedInvoice) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setViewMode('invoices')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('sweep.settings.billing.backToInvoices')}
          </Button>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>{selectedInvoice.id}</CardTitle>
                <CardDescription className="mt-2">
                  {formatDate(selectedInvoice.periodStart)} - {formatDate(selectedInvoice.periodEnd)}
                </CardDescription>
              </div>
              {getInvoiceStatusBadge(selectedInvoice.status)}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              {selectedInvoice.subtotalAmount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('sweep.settings.billing.subtotal')}</span>
                  <span className="font-medium">{formatCurrency(selectedInvoice.subtotalAmount)}</span>
                </div>
              )}
              {selectedInvoice.taxAmount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('sweep.settings.billing.tax')}
                    {selectedInvoice.customerCountry && (
                      <span className="ml-1">({selectedInvoice.customerCountry})</span>
                    )}
                  </span>
                  <span className="font-medium">{formatCurrency(selectedInvoice.taxAmount)}</span>
                </div>
              )}
              {selectedInvoice.customerTaxExempt === 'reverse' && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('sweep.settings.billing.tax')}</span>
                  <span className="text-muted-foreground text-xs">{t('sweep.settings.billing.reverseCharge')}</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between text-base">
                <span className="font-semibold">{t('settings.billing.total')}</span>
                <span className="font-bold">{formatCurrency(selectedInvoice.amount)}</span>
              </div>
            </div>

            {selectedInvoice.pdfUrl && (
              <Button variant="outline" className="w-full" asChild>
                <a href={selectedInvoice.pdfUrl} target="_blank" rel="noopener noreferrer">
                  <Download className="h-4 w-4 mr-2" />
                  {t('sweep.settings.billing.downloadInvoice')}
                </a>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Overview (Default View)
  const currentPlanForSeats = plans.find(p => p.id === subscription?.planId);
  const manageSeatsMin = Math.max(1, planLimits?.currentUsage.memberCount || 1);
  const manageSeatsMax = currentPlanForSeats?.maxMembers || undefined;
  const perSeatPrice = currentPlanForSeats
    ? (subscription?.cycle === Billing.BillingCycle.Yearly
        ? (currentPlanForSeats.yearlyPrice || Math.round(currentPlanForSeats.monthlyPrice * 10))
        : currentPlanForSeats.monthlyPrice)
    : 0;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Manage Seats Dialog */}
      <Dialog open={manageSeatsOpen} onOpenChange={setManageSeatsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('sweep.settings.billing.manageSeatsDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('sweep.settings.billing.manageSeatsDialog.description', { name: subscription?.planName })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Seat counter */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">{t('sweep.settings.billing.seats')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('sweep.settings.billing.manageSeatsDialog.currentlyInUse', { count: planLimits?.currentUsage.memberCount || 0 })}
                </p>
              </div>
              <div className="flex items-center border rounded-md overflow-hidden">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => setManageSeatCount(Math.max(manageSeatsMin, manageSeatCount - 1))}
                  disabled={manageSeatCount <= manageSeatsMin}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-8 text-center text-sm font-medium">{manageSeatCount}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => setManageSeatCount(manageSeatsMax ? Math.min(manageSeatsMax, manageSeatCount + 1) : manageSeatCount + 1)}
                  disabled={!!manageSeatsMax && manageSeatCount >= manageSeatsMax}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Summary line */}
            {perSeatPrice > 0 && (
              <p className="text-sm text-muted-foreground">
                {t('sweep.settings.billing.manageSeatsDialog.seatCount', { count: manageSeatCount })} &times;{' '}
                {formatPlanPrice(perSeatPrice, 'USD')}/{t('sweep.settings.billing.seat')} ={' '}
                <span className="font-medium text-foreground">
                  {formatPlanPrice(manageSeatCount * perSeatPrice, 'USD')}/{subscription?.cycle === Billing.BillingCycle.Yearly ? t('sweep.settings.billing.monthBilledAnnually') : t('sweep.settings.billing.month')}
                </span>
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setManageSeatsOpen(false)} disabled={processing}>
              {t('sweep.settings.billing.cancel')}
            </Button>
            <Button
              onClick={handleConfirmUpdateSeats}
              disabled={processing || manageSeatCount === (subscription?.purchasedSeats || 0)}
            >
              {processing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('sweep.settings.billing.updateSeats')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.billing.plansTitle')}</h1>
        <p className="text-muted-foreground">{t('sweep.settings.billing.overviewDescription')}</p>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Current Plan Section */}
      <div className="rounded-lg border">
        <div className="p-6 border-b">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold">{subscription?.planName?.replace(/\s*\d+$/, '') || subscription?.planName}</h2>
                {isTrialing ? (
                  <Badge variant="secondary" className="rounded-sm">{t('sweep.settings.billing.freeTrial')}</Badge>
                ) : subscription && subscription.pricePerCycle > 0 && (
                  <Badge variant={subscription.status === Billing.SubscriptionStatus.Active ? "default" : "secondary"} className="rounded-sm">
                    {subscription.status === Billing.SubscriptionStatus.Active ? t('sweep.settings.billing.activeBadge') : subscription.status}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {isTrialing ? (
                  trialEndsAt
                    ? <>{t('sweep.settings.billing.trialEndsOn', { date: formatDate(trialEndsAt) })}</>
                    : t('sweep.settings.billing.onFreeTrialNoEndDate')
                ) : !subscription ? (
                  // The permanent free plan has been retired — a workspace with
                  // no subscription record yet is pre-trial, not "free forever".
                  t('sweep.settings.billing.choosePlanToStart')
                ) : subscription.pricePerCycle === 0 ? (
                  // Legacy workspaces may still carry a $0 subscription from
                  // before the free plan was retired from `GET /billing/plans`.
                  t('sweep.settings.billing.noActivePlan')
                ) : (
                  <>
                    {formatCurrency(subscription.pricePerCycle)}/{subscription.cycle === Billing.BillingCycle.Monthly ? t('sweep.settings.billing.month') : t('sweep.settings.billing.year')}
                    {subscription.currentPeriodEnd && (
                      <span> &bull; {t('settings.billing.renews', { date: formatDate(subscription.currentPeriodEnd) })}</span>
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {subscription && subscription.pricePerCycle > 0 ? (
                <Button variant="outline" size="sm" onClick={handleChangePlan}>
                  {t('settings.billing.changePlan')}
                </Button>
              ) : (
                <Button size="sm" onClick={handleUpgrade}>
                  {t('sweep.settings.billing.upgrade')}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Team Members Section */}
        <div className="rounded-lg border">
          <div className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-primary/10 p-3">
                  <Users className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold">{t('sweep.settings.billing.teamMembers')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {planLimits ? (
                      <>
                        {t('sweep.settings.billing.memberCount', { count: planLimits.currentUsage.memberCount })}
                        {planLimits.maxMembers && (
                          <span> {t('sweep.settings.billing.ofMaxAllowed', { max: planLimits.maxMembers })}</span>
                        )}
                      </>
                    ) : (
                      t('sweep.settings.billing.manageYourTeam')
                    )}
                  </p>
                </div>
              </div>
              {subscription && subscription.pricePerCycle > 0 && (
                <Button variant="outline" size="sm" onClick={handleOpenManageSeats}>
                  {t('sweep.settings.billing.manageSeatsButton')}
                </Button>
              )}
            </div>

            {/* Members progress bar */}
            {planLimits && planLimits.maxMembers && (
              <div className="mt-4 space-y-2">
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      planLimits.currentUsage.memberCount >= (planLimits.maxMembers || 999) ? 'bg-amber-500' : 'bg-primary'
                    }`}
                    style={{
                      width: `${Math.min(100, (planLimits.currentUsage.memberCount / (planLimits.maxMembers || planLimits.currentUsage.memberCount)) * 100)}%`
                    }}
                  />
                </div>
                {planLimits.currentUsage.memberCount >= planLimits.maxMembers && (
                  <p className="text-xs text-amber-600">
                    {t('sweep.settings.billing.memberLimitReached')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Invoices Section */}
      {invoices.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">{t('sweep.settings.billing.invoicesTitle')}</h3>
            <Button variant="ghost" size="sm" onClick={handleViewAllInvoices}>
              {t('sweep.settings.billing.viewAll')}
            </Button>
          </div>
          <div className="rounded-lg border divide-y">
            {invoices.slice(0, 5).map((invoice) => (
              <div
                key={invoice.id}
                className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors cursor-pointer"
                onClick={() => handleViewInvoice(invoice)}
              >
                <div className="flex items-center gap-3">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{invoice.id}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(invoice.periodStart)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium">{formatCurrency(invoice.amount)}</span>
                  {getInvoiceStatusBadge(invoice.status)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History Section */}
      {invoices.length > 0 && (
        <div>
          <div className="mb-4">
            <h3 className="text-lg font-semibold">{t('settings.billing.history')}</h3>
            <p className="text-sm text-muted-foreground">{t('settings.billing.historyDescription')}</p>
          </div>
          <div className="rounded-lg border">
            {/* Table Header */}
            <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-4 px-4 py-3 border-b bg-muted/30 text-sm text-muted-foreground">
              <div>{t('settings.billing.reference')}</div>
              <div>{t('settings.billing.total')}</div>
              <div>{t('settings.billing.date')}</div>
              <div></div>
              <div></div>
            </div>
            {/* Table Rows */}
            <div className="divide-y">
              {invoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-4 px-4 py-3 items-center text-sm hover:bg-muted/50 transition-colors"
                >
                  <div className="font-medium">{invoice.id}</div>
                  <div>
                    {formatCurrency(invoice.amount)}
                    {invoice.taxAmount > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">
                        {t('sweep.settings.billing.inclTax', { amount: formatCurrency(invoice.taxAmount) })}
                      </span>
                    )}
                  </div>
                  <div>{format(new Date(invoice.periodStart), 'do MMM yyyy')}</div>
                  <div>
                    {getInvoiceStatusBadge(invoice.status)}
                  </div>
                  <div>
                    {invoice.pdfUrl && (
                      <a
                        href={invoice.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Download className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

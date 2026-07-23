
import { useState, useEffect } from 'react';
import { HostEntityFormLayout, type HostFormSection, type HostSummaryField } from '../../components/host-entity-form-layout';
import { DomainAvailabilityChecker, type TransformedDomainResult } from '../../components/domain-availability-checker';
import { Globe, CreditCard, CheckCircle2, Search, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { AlertCircle, Settings } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Link } from '@/lib/router';
import { redirectToCheckout } from '@/lib/host/domain-purchase-client';
import { toast } from 'sonner';
import { useAppApi } from '@/lib/api/use-app-api';
import { cn } from '@/lib/utils';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';

export function DomainRegistrationClient() {
  const { t } = useI18n();
  const tr = t.host.registration;

  const rotatingPhrases = [
    t.host.registrationPhrases.nextViralIdea,
    t.host.registrationPhrases.newStartup,
    t.host.registrationPhrases.sideProject,
    t.host.registrationPhrases.onlineStore,
    t.host.registrationPhrases.personalBrand,
    t.host.registrationPhrases.portfolio,
    t.host.registrationPhrases.business,
  ];

  useBreadcrumbs([
    { label: t.host.title, href: '/weldhost' },
    { label: t.host.domains.title, href: '/weldhost/domains' },
    { label: tr.title }
  ]);

  const { domains: domainsApi } = useAppApi();
  const [selectedDomains, setSelectedDomains] = useState<TransformedDomainResult[]>([]);
  const [autoRenew, setAutoRenew] = useState(true);
  const [isPending, setIsPending] = useState(false);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [hasSearched, setHasSearched] = useState(false);
  const [initialSearchQuery, setInitialSearchQuery] = useState('');
  const [currentPhraseIndex, setCurrentPhraseIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  // Rotate phrases
  useEffect(() => {
    const interval = setInterval(() => {
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentPhraseIndex((prev) => (prev + 1) % rotatingPhrases.length);
        setIsAnimating(false);
      }, 300);
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  const handleDomainSelect = (domain: TransformedDomainResult) => {
    setSelectedDomains(prev => {
      const exists = prev.find(d => d.domain_name === domain.domain_name);
      if (exists) {
        return prev.filter(d => d.domain_name !== domain.domain_name);
      }
      return [...prev, domain];
    });
  };

  const handleRemoveDomain = (domainName: string) => {
    setSelectedDomains(prev => prev.filter(d => d.domain_name !== domainName));
  };

  const toggleDomainExpand = (domainName: string) => {
    setExpandedDomains(prev => {
      const newSet = new Set(prev);
      if (newSet.has(domainName)) {
        newSet.delete(domainName);
      } else {
        newSet.add(domainName);
      }
      return newSet;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (selectedDomains.length === 0) {
      toast.error(tr.selectAtLeastOne);
      return;
    }

    setIsPending(true);
    try {
      // The new /api/domains/checkout endpoint registers one domain per call.
      // For multi-domain selections we kick off the first one — the user can
      // come back and register the rest. (Multi-domain checkout will land
      // alongside the cart flow if we keep the multi-select UI.)
      const first = selectedDomains[0];
      if (!first) {
        throw new Error('No domain selected');
      }
      const response = await domainsApi.checkout({
        domain: first.domain_name,
        autoRenew,
        years: 1,
        privacyProtection: true,
      });
      const checkoutUrl = response.data.checkoutUrl;
      if (!checkoutUrl) {
        throw new Error('Failed to create checkout session');
      }

      toast.success(
        tr.redirectingToCheckout
          .replace('{count}', String(selectedDomains.length))
          .replace('{plural}', selectedDomains.length > 1 ? 's' : '')
      );

      setTimeout(() => {
        redirectToCheckout(checkoutUrl);
      }, 1000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create checkout session';
      toast.error(errorMessage);
      setIsPending(false);
    }
  };

  // Initial hero state - Exact Vercel style
  if (!hasSearched) {
    return (
      <div
        className="min-h-[calc(100vh-100px)] flex flex-col items-center justify-center bg-[#fafafa] dark:bg-background"
      >
        <div className="w-full max-w-[540px] text-center px-4">
          {/* Title - responsive font size */}
          <h1
            className="leading-tight font-sans text-[32px] md:text-[48px] text-[#171717] dark:text-foreground"
            style={{
              fontWeight: 575,
              letterSpacing: '-0.02em',
            }}
          >
            {tr.heroTitle}
          </h1>

          {/* Animated subtitle - responsive font size */}
          <p
            className={cn(
              "leading-tight font-sans transition-all duration-300 -mt-2 md:-mt-3 text-[32px] md:text-[48px] text-[#888888] dark:text-muted-foreground",
              isAnimating ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0"
            )}
            style={{
              fontWeight: 450,
              letterSpacing: '-0.02em',
            }}
          >
            {rotatingPhrases[currentPhraseIndex]}
          </p>

          {/* Tagline */}
          <p
            className="mt-3 md:mt-4 text-sm md:text-base text-[#666666] dark:text-muted-foreground"
            style={{
              fontWeight: 400,
              fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }}
          >
            {tr.heroTagline}
          </p>

          {/* Search Input */}
          <div className="relative mt-6 md:mt-8">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              data-testid="domain-search-input"
              placeholder={tr.heroSearchPlaceholder}
              className="w-full h-[44px] pl-[44px] pr-[50px] text-sm outline-none rounded-xl bg-white dark:bg-secondary text-foreground placeholder:text-muted-foreground border border-[#eaeaea] dark:border-border focus:border-[#c0c0c0] dark:focus:border-muted-foreground transition-colors"
              style={{
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              }}
              value={initialSearchQuery}
              onChange={(e) => setInitialSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.currentTarget.value.trim().length >= 2) {
                  setHasSearched(true);
                }
              }}
            />
            {/* Search button */}
            <Button
              type="button"
              variant="ghost"
              data-testid="domain-search-button"
              className={cn(
                "absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center rounded-[7px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed p-0",
                initialSearchQuery.trim().length >= 2
                  ? "bg-[#171717] dark:bg-white hover:bg-[#171717] dark:hover:bg-white"
                  : "bg-[#e5e5e5] dark:bg-secondary hover:bg-[#e5e5e5] dark:hover:bg-secondary"
              )}
              disabled={initialSearchQuery.trim().length < 2}
              onClick={() => {
                if (initialSearchQuery.trim().length >= 2) {
                  setHasSearched(true);
                }
              }}
            >
              <ArrowRight className={cn(
                "h-4 w-4",
                initialSearchQuery.trim().length >= 2
                  ? "text-white dark:text-black"
                  : "text-muted-foreground"
              )} />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const formatPrice = (price: number | null | undefined) => {
    if (price === undefined || price === null) return '11,25';
    return price.toFixed(2).replace('.', ',');
  };

  const totalPrice = selectedDomains.reduce((sum, domain) => sum + (domain.price || 11.25), 0);
  const totalFormatted = formatPrice(totalPrice);

  // Mobile summary content (shown under search on mobile)
  const mobileSummaryContent = selectedDomains.length > 0 ? (
    <div className="bg-background rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold">{tr.purchaseSummary}</h3>
      {selectedDomains.map((domain, index) => {
        const priceFormatted = formatPrice(domain.price);
        return (
          <div key={domain.domain_name} className={`flex items-center justify-between ${index > 0 ? 'pt-2 border-t border-input' : ''}`}>
            <span className="text-sm truncate mr-2">{domain.domain_name}</span>
            <span className="text-sm font-medium flex-shrink-0">US$ {priceFormatted}</span>
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-2 border-t border-input">
        <span className="text-sm font-semibold">{tr.total}</span>
        <span className="text-sm font-semibold">US$ {totalFormatted}</span>
      </div>
      <Button
        onClick={handleSubmit}
        disabled={isPending || selectedDomains.length === 0}
        className="w-full mt-2"
        size="sm"
      >
        {isPending ? tr.processing : tr.proceedToPayment}
      </Button>
    </div>
  ) : null;

  // Form sections
  const sections: HostFormSection[] = [
    {
      title: '',
      icon: Search,
      description: '',
      content: (
        <DomainAvailabilityChecker
          showCategories={true}
          onDomainSelect={handleDomainSelect}
          onDomainRemove={handleRemoveDomain}
          selectedDomainNames={selectedDomains.map(d => d.domain_name)}
          initialSearchTerm={initialSearchQuery}
          mobileSlot={mobileSummaryContent}
        />
      ),
    },
  ];

  const summaryFields: HostSummaryField[] = [];

  const summaryBottomFields: HostSummaryField[] = [
    {
      label: <span className="text-base">{tr.total}</span>,
      value: <span className="text-base font-semibold">US$ {totalFormatted}</span>,
      bordered: false,
    },
  ];

  const summaryContent = selectedDomains.length > 0 ? (
    <div className="space-y-3">
      {selectedDomains.map((domain, index) => {
        const priceFormatted = formatPrice(domain.price);
        const isExpanded = expandedDomains.has(domain.domain_name);

        return (
          <div key={domain.domain_name} className={`group space-y-2 ${index > 0 ? 'pt-4 mt-4 border-t border-input' : ''}`}>
            <div
              className="flex items-center justify-between cursor-pointer"
              onClick={() => toggleDomainExpand(domain.domain_name)}
            >
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium">{domain.domain_name}</span>
                {isExpanded ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground transition-opacity" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </div>
              <span className="text-sm font-medium">US$ {priceFormatted}</span>
            </div>

            {isExpanded && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tr.registrationPeriod}</span>
                  <span className="font-medium">{tr.oneYear}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tr.autoRenew}</span>
                  <span className="font-medium">{autoRenew ? tr.enabled : tr.disabled}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tr.whoisPrivacy}</span>
                  <span className="font-medium">{tr.free}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tr.dnsManagement}</span>
                  <span className="font-medium">{tr.free}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tr.customerSupport}</span>
                  <span className="font-medium">{tr.support247}</span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemoveDomain(domain.domain_name);
                }}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline h-auto p-0"
              >
                {tr.remove}
              </Button>
              <span className="text-xs text-muted-foreground">
                {tr.renewsAt.replace('{price}', priceFormatted)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  ) : null;

  return (
    <HostEntityFormLayout
      title={tr.title}
      subtitle={tr.subtitle}
      sections={sections}
      summaryTitle={tr.purchaseSummary}
      summaryIcon={Globe}
      summaryFields={summaryFields}
      summaryBottomFields={summaryBottomFields}
      summaryContent={summaryContent}
      onSubmit={handleSubmit}
      isPending={isPending || selectedDomains.length === 0}
      submitText={tr.proceedToPayment}
      submitVariant="default"
      showBackButton={false}
      hideMobileSummary={true}
    />
  );
}

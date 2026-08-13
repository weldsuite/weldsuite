
import { useEffect, useState, useCallback, useRef } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { Button } from '@weldsuite/ui/components/button';
import {
  Search,
  Globe,
  Check,
  X,
  Loader2,
  AlertCircle,
  ShoppingCart,
} from 'lucide-react';
import { useAppApi } from '@/lib/api/use-app-api';
import { isApiError, isNetworkError } from '@weldsuite/api-client';
import type { DomainSearchResult } from '@weldsuite/core-api-client/schemas/domains';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { formatDomainPrice } from '../lib/format-domain-price';
import { findExactTakenMatch, isTakenDomainResult } from '../lib/domain-search-match';

// Re-export under the legacy name so existing consumers (domain-search-client.tsx,
// domain-registration-client.tsx) keep compiling without changes.
export type TransformedDomainResult = DomainSearchResult;

interface DomainAvailabilityCheckerProps {
  onDomainSelect?: (domain: TransformedDomainResult) => void;
  onDomainRemove?: (domainName: string) => void;
  selectedDomainNames?: string[];
  className?: string;
  showCategories?: boolean;
  initialSearchTerm?: string;
  /** Content to render between search input and results on mobile only */
  mobileSlot?: React.ReactNode;
}

export function DomainAvailabilityChecker({
  onDomainSelect,
  onDomainRemove,
  selectedDomainNames = [],
  className,
  initialSearchTerm = '',
  mobileSlot,
}: DomainAvailabilityCheckerProps) {
  const { t, language } = useI18n();
  const ta = t.host.availability;

  const [searchTerm, setSearchTerm] = useState(initialSearchTerm);
  const [isLoading, setIsLoading] = useState(false);
  const [domainResults, setDomainResults] = useState<DomainSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { domains: domainsApi } = useAppApi();
  const debounceTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run search against the app-api endpoint
  const runSearch = useCallback(
    async (query: string) => {
      setIsLoading(true);
      setDomainResults([]);
      setError(null);

      try {
        const response = await domainsApi.search({ q: query, limit: 20 });
        // DataResponse<DomainSearchResult[]> — data field holds the array
        const results = Array.isArray(response?.data) ? response.data : [];
        setDomainResults(results);
      } catch (err) {
        // Only claim a connectivity problem when the request genuinely never
        // reached the server. A 503 (registrar not configured) or a 5xx is a
        // server-side failure and must not be reported as "check your
        // internet connection" — that misdirection has cost real debugging
        // time before.
        if (isNetworkError(err)) {
          setError(ta.connectionError);
        } else if (isApiError(err) && err.status === 503) {
          setError(ta.serviceUnavailable);
        } else {
          setError(ta.searchFailed);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [domainsApi, ta.connectionError, ta.serviceUnavailable, ta.searchFailed],
  );

  // Handle search input with 300ms debounce
  const handleSearch = useCallback(
    (value: string) => {
      setSearchTerm(value);

      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current);
      }

      if (value.length < 2) {
        setIsLoading(false);
        setDomainResults([]);
        setError(null);
        return;
      }

      setIsLoading(true);

      debounceTimeout.current = setTimeout(() => {
        void runSearch(value);
      }, 300);
    },
    [runSearch],
  );

  // Trigger initial search once if initialSearchTerm is long enough
  const hasInitialSearched = useRef(false);
  useEffect(() => {
    if (initialSearchTerm && initialSearchTerm.length >= 2 && !hasInitialSearched.current) {
      hasInitialSearched.current = true;
      void runSearch(initialSearchTerm);
    }
    // Only run on mount — runSearch is stable thanks to useCallback + useMemo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    };
  }, []);

  return (
    <div className={className}>
      {/* Error Alert */}
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{ta.error}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={searchTerm}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={ta.placeholder}
          className="pl-10 h-12 text-lg bg-background rounded-lg"
        />
      </div>

      {/* Mobile slot - renders between search and results on mobile only */}
      {mobileSlot && (
        <div className="md:hidden mt-4">
          {mobileSlot}
        </div>
      )}

      {/* Initial Empty State - before search */}
      {searchTerm.length < 2 && (
        <div className="flex flex-col items-center justify-center text-center py-16">
          <p className="text-muted-foreground">
            {ta.enterDomain}
          </p>
        </div>
      )}

      {/* Results Container - min-height prevents layout shift */}
      {searchTerm.length >= 2 && (
        <div className="mt-4 space-y-6 min-h-[200px]">
          {/* Exact Match — Unavailable (shown at the very top) */}
          {(() => {
            const exactMatch = findExactTakenMatch(searchTerm, domainResults);

            if (!exactMatch) return null;

            return (
              <div className="border border-destructive/30 rounded-lg bg-card" data-testid="exact-taken-match">
                <div className="bg-destructive/10 px-4 md:px-6 py-3 rounded-t-lg">
                  <div className="flex items-center gap-2 text-destructive text-base md:text-lg font-semibold">
                    <AlertCircle className="h-5 w-5 flex-shrink-0" />
                    <span>{ta.domainUnavailable}</span>
                  </div>
                  <p className="text-sm text-destructive/80 mt-0.5">{ta.alreadyRegistered}</p>
                </div>
                <div className="pt-4 md:pt-6 px-4 md:px-6 pb-4 md:pb-6">
                  <div className="flex items-center justify-between p-3 md:p-4 border border-destructive/30 rounded-lg bg-destructive/10 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-10 w-10 md:h-12 md:w-12 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                        <X className="h-5 w-5 md:h-6 md:w-6 text-destructive" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-base md:text-xl truncate text-foreground">{exactMatch.domain_name}</p>
                        <p className="text-xs md:text-sm text-destructive font-medium mt-0.5 md:mt-1">{ta.domainAlreadyRegistered}</p>
                      </div>
                    </div>
                    <Badge variant="destructive" className="gap-1 flex-shrink-0">
                      <AlertCircle className="h-3 w-3" />
                      {ta.taken}
                    </Badge>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Domain Matches */}
          {domainResults.length > 0 && (
            <div className="bg-card rounded-lg border border-border">
              <div className="divide-y divide-border">
                {domainResults.map((result) => {
                  const isTaken = isTakenDomainResult(result);
                  const isUnavailable = result.status === 2 && !isTaken;
                  // `price` is in cents — formatDomainPrice divides. It returns
                  // null when there is nothing to show, which also gates the cart.
                  const priceLabel = formatDomainPrice(result.price, result.currency, language);
                  const hasPrice = priceLabel !== null;
                  const isSelected = selectedDomainNames.includes(result.domain_name);
                  const canSelect = !isTaken && !isUnavailable && hasPrice;

                  return (
                    <div
                      key={result.domain_name}
                      data-testid={`domain-result-${result.domain_name}`}
                      className="flex items-center justify-between px-3 py-3 hover:bg-muted/50 transition-colors gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p
                          className={cn(
                            'text-sm md:text-base font-medium truncate',
                            isTaken || isUnavailable ? 'text-muted-foreground' : 'text-foreground',
                          )}
                        >
                          {result.domain_name}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 md:gap-3 flex-shrink-0">
                        <div className="text-right min-w-[70px] md:min-w-[100px]">
                          {isTaken ? (
                            <Badge variant="destructive" className="gap-1" data-testid="domain-taken-badge">
                              <AlertCircle className="h-3 w-3" />
                              {ta.taken}
                            </Badge>
                          ) : (
                            <p
                              className={cn(
                                'text-sm md:text-base font-medium',
                                isUnavailable ? 'text-muted-foreground' : 'text-foreground',
                              )}
                            >
                              {priceLabel ?? (
                                <span className="text-muted-foreground text-xs md:text-sm">{ta.unavailable}</span>
                              )}
                            </p>
                          )}
                        </div>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={!canSelect}
                                className={cn(
                                  'h-9 w-9 flex items-center justify-center border rounded-md transition-colors',
                                  !canSelect
                                    ? 'border-input bg-muted cursor-not-allowed opacity-50'
                                    : isSelected
                                      ? 'bg-primary border-primary hover:bg-primary/90'
                                      : 'border-input hover:bg-muted/50',
                                )}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();

                                  if (!canSelect) return;

                                  if (isSelected) {
                                    onDomainRemove?.(result.domain_name);
                                  } else {
                                    onDomainSelect?.(result);
                                  }
                                }}
                              >
                                {isTaken || isUnavailable ? (
                                  <X className="h-4 w-4 text-muted-foreground/50" />
                                ) : isSelected ? (
                                  <Check className="h-4 w-4 text-primary-foreground" />
                                ) : (
                                  <ShoppingCart className="h-4 w-4 text-muted-foreground" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            {isTaken && (
                              <TooltipContent>
                                <p>{ta.domainAlreadyRegisteredTooltip}</p>
                              </TooltipContent>
                            )}
                            {(!hasPrice && !isTaken && !isUnavailable) && (
                              <TooltipContent>
                                <p>{ta.unavailable}</p>
                              </TooltipContent>
                            )}
                            {isUnavailable && (
                              <TooltipContent>
                                <p>{ta.unavailable}</p>
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Loading State */}
          {isLoading && domainResults.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{ta.searching}</span>
            </div>
          )}

          {/* Empty State */}
          {!isLoading && domainResults.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-12">
              <Globe className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-3">{ta.noResults}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

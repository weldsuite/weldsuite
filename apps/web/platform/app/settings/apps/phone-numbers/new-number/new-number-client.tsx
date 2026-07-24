
import { useState, useEffect, useMemo } from 'react';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import { HostEntityFormLayout, type HostFormSection, type HostSummaryField } from '@/app/weldhost/components/host-entity-form-layout';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Phone,
  Plus,
  Loader2,
  Search,
  MapPin,
  Check,
  AlertTriangle,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  ShoppingCart,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  useSearchAvailableNumbers,
  useProvisionPhoneNumber,
  useCreateAddress,
} from '@/hooks/use-phone-numbers';

interface ProviderAddress {
  id: string;
  sid?: string; // legacy
  business_name: string;
  first_name?: string;
  last_name?: string;
  friendly_name?: string;
  customer_name?: string;
  street_address?: string;
  street?: string;
  locality?: string;
  city?: string;
  administrative_area?: string;
  region?: string;
  postal_code: string;
  country_code?: string;
  iso_country?: string;
  validated: boolean;
}

interface PricingEntry {
  countryCode: string;
  numberType: string;
  monthlyPrice: number;
  currency: string;
  stripePriceId?: string;
}

interface ProviderBundle {
  id: string;
  country_code?: string;
  iso_country?: string;
  friendly_name?: string;
  description?: string;
}

interface NewNumberClientProps {
  isConfigured: boolean;
  addresses: ProviderAddress[];
  bundles: ProviderBundle[];
  pricingData: PricingEntry[];
}

interface AvailableNumber {
  phone_number: string;
  friendly_name?: string;
  iso_country?: string;
  region?: string;
  locality?: string;
  postal_code?: string;
  // Telnyx fields
  phone_number_type?: string;
  region_information?: Array<{ region_name: string; region_type: string }>;
  cost_information?: { currency: string; monthly_cost: string; upfront_cost: string };
  features?: Array<{ name: string }>;
  // Twilio legacy fields
  capabilities?: { voice: boolean; sms: boolean; mms: boolean };
  address_requirements?: string;
}

const COUNTRIES = [
  { code: 'US', name: 'United States', prefix: '+1', requiresAddress: false },
  { code: 'CA', name: 'Canada', prefix: '+1', requiresAddress: false },
  { code: 'GB', name: 'United Kingdom', prefix: '+44', requiresAddress: false },
  { code: 'NL', name: 'Netherlands', prefix: '+31', requiresAddress: true },
  { code: 'DE', name: 'Germany', prefix: '+49', requiresAddress: true },
  { code: 'FR', name: 'France', prefix: '+33', requiresAddress: true },
  { code: 'BE', name: 'Belgium', prefix: '+32', requiresAddress: true },
  { code: 'AT', name: 'Austria', prefix: '+43', requiresAddress: true },
  { code: 'CH', name: 'Switzerland', prefix: '+41', requiresAddress: true },
  { code: 'AU', name: 'Australia', prefix: '+61', requiresAddress: false },
  { code: 'ES', name: 'Spain', prefix: '+34', requiresAddress: true },
  { code: 'IT', name: 'Italy', prefix: '+39', requiresAddress: true },
  { code: 'SE', name: 'Sweden', prefix: '+46', requiresAddress: true },
  { code: 'NO', name: 'Norway', prefix: '+47', requiresAddress: true },
  { code: 'DK', name: 'Denmark', prefix: '+45', requiresAddress: true },
  { code: 'PL', name: 'Poland', prefix: '+48', requiresAddress: true },
];

const NUMBER_TYPES = [
  { value: 'local', label: 'Local' },
  { value: 'toll-free', label: 'Toll-Free' },
  { value: 'mobile', label: 'Mobile' },
];

export function NewNumberClient({
  addresses: initialAddresses,
  bundles: initialBundles,
  pricingData,
}: NewNumberClientProps) {
  const router = useRouter();
  const st = useTranslations();
  const ts = getTranslations('settings');
  const tn = ts.phoneNumbers.newNumber;
  const tna = ts.phoneNumbers.newNumber.addressDialog;
  const [addresses, setAddresses] = useState(initialAddresses);
  const [bundles] = useState(initialBundles);

  // Mutation hooks
  const searchMutation = useSearchAvailableNumbers();
  const provisionMutation = useProvisionPhoneNumber();
  const createAddressMutation = useCreateAddress();

  // Build a lookup map from pricing data
  const pricingMap = useMemo(() => {
    const map: Record<string, { monthlyPrice: number; currency: string; stripePriceId?: string }> = {};
    for (const p of pricingData) {
      map[`${p.countryCode}:${p.numberType}`] = { monthlyPrice: p.monthlyPrice, currency: p.currency, stripePriceId: p.stripePriceId };
    }
    return map;
  }, [pricingData]);

  const getPrice = (countryCode: string, numberType: string) =>
    pricingMap[`${countryCode}:${numberType}`] ?? null;

  const formatPrice = (countryCode: string, numberType: string) => {
    const price = getPrice(countryCode, numberType);
    if (!price) return tn.notAvailable;
    return `${price.currency} ${price.monthlyPrice.toFixed(2)}/mo`;
  };

  // Search state
  const [countryOpen, setCountryOpen] = useState(false);
  const [searchCountry, setSearchCountry] = useState('US');
  const [searchAreaCode, setSearchAreaCode] = useState('');
  const [searchContains, setSearchContains] = useState('');
  const [searchType, setSearchType] = useState<'local' | 'toll-free' | 'mobile'>('local');
  const [isSearching, setIsSearching] = useState(false);
  const [availableNumbers, setAvailableNumbers] = useState<AvailableNumber[]>([]);
  const [previewedNumber, setPreviewedNumber] = useState<AvailableNumber | null>(null);
  const [cartNumbers, setCartNumbers] = useState<AvailableNumber[]>([]);
  const [expandedCartNumbers, setExpandedCartNumbers] = useState<Set<string>>(new Set());
  const [isProvisioning, setIsProvisioning] = useState(false);

  // Address selection state
  const [selectedAddressId, setSelectedAddressId] = useState<string>('');
  const [selectedBundleId, setSelectedBundleId] = useState<string>('');
  const [isAddressDialogOpen, setIsAddressDialogOpen] = useState(false);
  const [isCreatingAddress, setIsCreatingAddress] = useState(false);

  // New address form state
  const [newAddress, setNewAddress] = useState({
    customerName: '',
    street: '',
    streetSecondary: '',
    city: '',
    region: '',
    postalCode: '',
    isoCountry: 'NL',
    friendlyName: '',
  });

  // Auto-search on filter change
  useEffect(() => {
    handleSearchNumbers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCountry, searchType, searchAreaCode, searchContains]);

  const handleAddToCart = (num: AvailableNumber) => {
    setCartNumbers(prev => {
      const exists = prev.find(n => n.phone_number === num.phone_number);
      if (exists) return prev;
      return [...prev, num];
    });
    setPreviewedNumber(null);
  };

  const handleRemoveFromCart = (phoneNumber: string) => {
    setCartNumbers(prev => prev.filter(n => n.phone_number !== phoneNumber));
    setExpandedCartNumbers(prev => {
      const next = new Set(prev);
      next.delete(phoneNumber);
      return next;
    });
  };

  const toggleCartExpand = (phoneNumber: string) => {
    setExpandedCartNumbers(prev => {
      const next = new Set(prev);
      if (next.has(phoneNumber)) {
        next.delete(phoneNumber);
      } else {
        next.add(phoneNumber);
      }
      return next;
    });
  };

  const selectedCountryRequiresAddress = COUNTRIES.find(c => c.code === searchCountry)?.requiresAddress ?? false;
  const countryAddresses = addresses.filter(a => (a.country_code || a.iso_country) === searchCountry);
  const countryBundles = bundles.filter(b => (b.country_code || b.iso_country) === searchCountry);

  const handleSearchNumbers = async () => {
    setIsSearching(true);
    setAvailableNumbers([]);
    setPreviewedNumber(null);
    try {
      const result = await searchMutation.mutateAsync({
        country: searchCountry,
        areaCode: searchAreaCode || undefined,
        contains: searchContains || undefined,
        type: searchType,
        limit: 20,
      });
      const numbers = result.data?.numbers || [];
      setAvailableNumbers(numbers);
      if (numbers.length === 0) {
        toast.info(tn.noNumbersFound);
      }
    } catch (error) {
      console.error('Search error:', error);
      toast.error(st('sweep.settings.newNumber.searchFailed'));
    } finally {
      setIsSearching(false);
    }
  };

  const handleProvisionNumbers = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (cartNumbers.length === 0) return;
    if (selectedCountryRequiresAddress && !selectedAddressId && !selectedBundleId) {
      toast.error(tn.addressRequired2);
      return;
    }
    setIsProvisioning(true);
    try {
      for (const num of cartNumbers) {
        const result = await provisionMutation.mutateAsync({
          phoneNumber: num.phone_number,
          friendlyName: num.friendly_name || num.phone_number || num.phone_number,
          displayName: undefined,
          countryCode: num.iso_country || searchCountry,
          numberType: searchType,
          addressId: selectedAddressId || undefined,
        });

        // Handle checkout redirect (user has no payment method)
        if (result.checkoutUrl) {
          window.location.href = result.checkoutUrl;
          return;
        }

        if (!result.success) {
          toast.error(result.error?.message || st('sweep.settings.newNumber.addFailed', { name: num.friendly_name || num.phone_number }));
          setIsProvisioning(false);
          return;
        }
      }
      toast.success(cartNumbers.length === 1 ? tn.provisioning : tn.provisioningMultiple.replace('{count}', String(cartNumbers.length)));
      router.push('/settings/apps/phone-numbers');
    } catch (error) {
      console.error('Provision error:', error);
      toast.error(tn.provisionFailed);
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleCreateAddress = async () => {
    if (!newAddress.customerName || !newAddress.street || !newAddress.city || !newAddress.postalCode) {
      toast.error(tna.messages.requiredFields);
      return;
    }
    setIsCreatingAddress(true);
    try {
      const result = await createAddressMutation.mutateAsync({
        customerName: newAddress.customerName,
        street: newAddress.street,
        streetSecondary: newAddress.streetSecondary || undefined,
        city: newAddress.city,
        region: newAddress.region,
        postalCode: newAddress.postalCode,
        isoCountry: newAddress.isoCountry,
        friendlyName: newAddress.friendlyName || `${newAddress.city} Office`,
      });
      const address = result.data?.address;
      if (address) {
        toast.success(tna.messages.created);
        setAddresses(prev => [...prev, address]);
        setSelectedAddressId(address.id);
        setIsAddressDialogOpen(false);
        setNewAddress({
          customerName: '', street: '', streetSecondary: '', city: '',
          region: '', postalCode: '', isoCountry: searchCountry, friendlyName: '',
        });
      } else {
        toast.error(tna.messages.createFailed);
      }
    } catch (error) {
      console.error('Create address error:', error);
      toast.error(tna.messages.createFailed);
    } finally {
      setIsCreatingAddress(false);
    }
  };

  const isPreviewingNumber = !!previewedNumber;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isPreviewingNumber && previewedNumber) {
      handleAddToCart(previewedNumber);
      setPreviewedNumber(null);
      return;
    }
    handleProvisionNumbers(e);
  };

  const isSubmitDisabled = (!isPreviewingNumber && cartNumbers.length === 0) || isProvisioning || (!isPreviewingNumber && cartNumbers.length > 0 && selectedCountryRequiresAddress && !selectedAddressId && !selectedBundleId);

  const allCartPriced = cartNumbers.length > 0 && cartNumbers.every(num => getPrice(num.iso_country, searchType) !== null);
  const totalPrice = cartNumbers.reduce((sum, num) => sum + (getPrice(num.iso_country, searchType)?.monthlyPrice ?? 0), 0);
  const totalFormatted = totalPrice.toFixed(2);
  const cartCurrency = cartNumbers.length > 0 ? (getPrice(cartNumbers[0].iso_country, searchType)?.currency ?? 'USD') : 'USD';

  const submitText = isProvisioning
    ? tn.processing
    : isPreviewingNumber
      ? <><ShoppingCart className="h-4 w-4 mr-0.5" />{tn.addToCart}</>
      : cartNumbers.length > 0
        ? tn.proceedToPayment
        : tn.selectANumber;

  // --- Summary sidebar content ---
  const summaryFields: HostSummaryField[] = [];

  // Show preview fields when previewing a number
  const displayedNumber = previewedNumber;
  if (displayedNumber) {
    summaryFields.push(
      { label: ts.phoneNumbers.columns.number, value: displayedNumber.friendly_name },
      { label: tn.summaryCountry, value: COUNTRIES.find(c => c.code === displayedNumber.iso_country)?.name || displayedNumber.iso_country },
      { label: tn.summaryType, value: NUMBER_TYPES.find(t => t.value === searchType)?.label || searchType },
    );
    if (displayedNumber.locality) {
      summaryFields.push({ label: tn.summaryLocation, value: `${displayedNumber.locality}${displayedNumber.region ? `, ${displayedNumber.region}` : ''}` });
    }
    const caps = [
      displayedNumber.capabilities.voice && 'Voice',
      displayedNumber.capabilities.sms && 'SMS',
      displayedNumber.capabilities.mms && 'MMS',
    ].filter(Boolean).join(', ');
    if (caps) {
      summaryFields.push({ label: tn.summaryCapabilities, value: caps });
    }
  }

  // Summary content — cart items list (domain register style), hidden when previewing
  const summaryContent = isPreviewingNumber ? null : cartNumbers.length > 0 ? (
    <div className="space-y-3">
      {cartNumbers.map((num, index) => {
        const isExpanded = expandedCartNumbers.has(num.phone_number);
        const country = COUNTRIES.find(c => c.code === num.iso_country);

        return (
          <div key={num.phone_number} className={`group space-y-2 ${index > 0 ? 'pt-4 mt-4 border-t border-input' : ''}`}>
            <div
              className="flex items-center justify-between cursor-pointer"
              onClick={() => toggleCartExpand(num.phone_number)}
            >
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium">{num.friendly_name || num.phone_number}</span>
                {isExpanded ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground transition-opacity" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </div>
              <span className="text-sm font-medium">{formatPrice(num.iso_country, searchType)}</span>
            </div>

            {isExpanded && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tn.summaryCountry}</span>
                  <span className="font-medium">{country?.name || num.iso_country}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tn.summaryType}</span>
                  <span className="font-medium">{NUMBER_TYPES.find(t => t.value === searchType)?.label || searchType}</span>
                </div>
                {num.locality && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{tn.summaryLocation}</span>
                    <span className="font-medium">{num.locality}{num.region ? `, ${num.region}` : ''}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{tn.summaryCapabilities}</span>
                  <span className="font-medium">
                    {[num.capabilities.voice && 'Voice', num.capabilities.sms && 'SMS', num.capabilities.mms && 'MMS'].filter(Boolean).join(', ')}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemoveFromCart(num.phone_number);
                }}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {tn.remove}
              </Button>
              <span className="text-xs text-muted-foreground">{getPrice(num.iso_country, searchType) ? tn.renewsAt.replace('{price}', formatPrice(num.iso_country, searchType)) : tn.priceNotAvailable}</span>
            </div>
          </div>
        );
      })}
    </div>
  ) : !displayedNumber ? (
    <div className="flex items-center justify-center text-center py-8">
      <p className="text-sm text-muted-foreground">{tn.cartEmpty}</p>
    </div>
  ) : null;

  // --- Form sections (left column) ---
  const sections: HostFormSection[] = [
    {
      title: '',
      icon: Search,
      description: '',
      content: (
        <div className="space-y-4">
            <div className="bg-background rounded-lg border border-border px-4 md:px-6 py-5 md:py-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{tn.countryLabel}</Label>
                  <Popover open={countryOpen} onOpenChange={setCountryOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={countryOpen}
                        className="w-full justify-between font-normal"
                      >
                        {COUNTRIES.find(c => c.code === searchCountry)
                          ? `${COUNTRIES.find(c => c.code === searchCountry)!.name} (${COUNTRIES.find(c => c.code === searchCountry)!.prefix})`
                          : tn.selectCountry}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                      <Command>
                        <CommandInput placeholder={st('sweep.settings.newNumber.searchCountryPlaceholder')} />
                        <CommandList className="[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
                          <CommandEmpty>{st('sweep.settings.newNumber.noCountryFound')}</CommandEmpty>
                          <CommandGroup>
                            {COUNTRIES.map((country) => (
                              <CommandItem
                                key={country.code}
                                value={`${country.name} ${country.prefix}`}
                                onSelect={() => {
                                  setSearchCountry(country.code);
                                  setCountryOpen(false);
                                }}
                              >
                                {country.name} ({country.prefix})
                                <Check
                                  className={`ml-auto h-4 w-4 ${searchCountry === country.code ? 'opacity-100' : 'opacity-0'}`}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label>{tn.numberTypeLabel}</Label>
                  <Select value={searchType} onValueChange={(v) => setSearchType(v as typeof searchType)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {NUMBER_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{tn.areaCodeLabel}</Label>
                  <Input placeholder={tn.areaCodePlaceholder} value={searchAreaCode} onChange={(e) => setSearchAreaCode(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>{tn.containsLabel}</Label>
                  <Input placeholder={tn.containsPlaceholder} value={searchContains} onChange={(e) => setSearchContains(e.target.value)} />
                </div>
              </div>

              {/* Address Requirement Warning */}
              {selectedCountryRequiresAddress && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="font-medium text-yellow-800 dark:text-yellow-200">
                        {tn.addressRequired.replace('{country}', COUNTRIES.find(c => c.code === searchCountry)?.name ?? searchCountry)}
                      </p>
                      <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                        {tn.addressRequiredDescription}
                      </p>

                      {countryAddresses.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <Label className="text-yellow-800 dark:text-yellow-200">{tn.selectAddress}</Label>
                          <Select value={selectedAddressId} onValueChange={setSelectedAddressId}>
                            <SelectTrigger className="bg-white dark:bg-secondary">
                              <SelectValue placeholder={tn.selectAddressPlaceholder} />
                            </SelectTrigger>
                            <SelectContent>
                              {countryAddresses.map((addr) => (
                                <SelectItem key={addr.id} value={addr.id}>
                                  <div className="flex flex-col">
                                    <span>{addr.business_name || addr.friendly_name || addr.customer_name}</span>
                                    <span className="text-xs text-muted-foreground">{addr.street_address || addr.street}, {addr.locality || addr.city}</span>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {countryBundles.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <Label className="text-yellow-800 dark:text-yellow-200">{tn.selectBundle}</Label>
                          <Select value={selectedBundleId} onValueChange={setSelectedBundleId}>
                            <SelectTrigger className="bg-white dark:bg-secondary">
                              <SelectValue placeholder={tn.selectBundlePlaceholder} />
                            </SelectTrigger>
                            <SelectContent>
                              {countryBundles.map((bundle) => (
                                <SelectItem key={bundle.id} value={bundle.id}>
                                  {bundle.friendly_name || bundle.description || bundle.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => {
                          setNewAddress(prev => ({ ...prev, isoCountry: searchCountry }));
                          setIsAddressDialogOpen(true);
                        }}
                      >
                        <Plus className="h-4 w-4 mr-1.5" />
                        {tn.addNewAddress}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

            </div>

              {/* Loading State */}
              {isSearching && availableNumbers.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-12">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {tn.searching}
                  </p>
                </div>
              )}

              {/* Available Numbers List — Domain-style rows */}
              {availableNumbers.length > 0 && (
                <div className="bg-white dark:bg-background rounded-lg border border-border">
                  <div className="divide-y divide-border">
                    {availableNumbers.map((num) => {
                      const isInCart = cartNumbers.some(n => n.phone_number === num.phone_number);

                      return (
                        <div
                          key={num.phone_number}
                          className={`flex items-center justify-between px-3 py-3 hover:bg-gray-50 dark:hover:bg-muted/50 transition-colors gap-2 cursor-pointer ${
                            previewedNumber?.phone_number === num.phone_number ? 'bg-gray-50 dark:bg-muted/50' : ''
                          }`}
                          onClick={() => setPreviewedNumber(previewedNumber?.phone_number === num.phone_number ? null : num)}
                        >
                          <div className="flex-1 min-w-0 flex items-center gap-2">
                            <p className="text-sm md:text-base font-medium font-mono text-gray-900 dark:text-foreground truncate">
                              {num.friendly_name || num.phone_number}
                            </p>
                            {num.locality && (
                              <Badge variant="secondary" className="hidden md:inline-flex font-mono text-xs rounded-md border border-border flex-shrink-0">
                                {num.locality}{num.region ? `, ${num.region}` : ''}
                              </Badge>
                            )}
                          </div>

                          <div className="flex items-center gap-2 md:gap-3 flex-shrink-0">
                            <div className="text-right min-w-[70px] md:min-w-[100px]">
                              <p className="text-sm md:text-base font-medium text-gray-900 dark:text-foreground">
                                {formatPrice(num.iso_country, searchType)}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={`h-9 w-9 flex items-center justify-center border rounded-md transition-colors ${
                                isInCart
                                  ? 'bg-primary border-primary'
                                  : 'border-input hover:bg-gray-50 dark:hover:bg-muted'
                              }`}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (isInCart) {
                                  handleRemoveFromCart(num.phone_number);
                                } else {
                                  handleAddToCart(num);
                                }
                              }}
                            >
                              {isInCart ? (
                                <Check className="h-4 w-4 text-primary-foreground" />
                              ) : (
                                <ShoppingCart className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
        </div>
      ),
    },
  ];

  return (
    <>
      <HostEntityFormLayout
        title={tn.title}
        subtitle={tn.subtitle}
        sections={sections}
        summaryTitle={isPreviewingNumber ? tn.numberSummary : tn.purchaseSummary}
        summaryIcon={Phone}
        summaryFields={summaryFields}
        summaryBottomFields={!isPreviewingNumber && cartNumbers.length > 0 ? [
          {
            label: <span className="text-base">{tn.total}</span>,
            value: <span className="text-base font-semibold">{allCartPriced ? `${cartCurrency} ${totalFormatted}/mo` : tn.notAvailable}</span>,
            bordered: false,
          },
        ] : undefined}
        summaryContent={summaryContent}
        onSubmit={handleSubmit}
        isPending={isSubmitDisabled}
        submitText={submitText}
        showBackButton={true}
        backLink="/settings/apps/phone-numbers"
        backButtonText={tn.backToNumbers}
        hideMobileSummary={true}
        summaryHeaderAction={isPreviewingNumber ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setPreviewedNumber(null)}
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors -mt-0.5"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        ) : undefined}
      />

      {/* Create Address Dialog */}
      <Dialog open={isAddressDialogOpen} onOpenChange={setIsAddressDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              {tna.title}
            </DialogTitle>
            <DialogDescription>
              {tna.description.replace('{country}', COUNTRIES.find(c => c.code === newAddress.isoCountry)?.name ?? newAddress.isoCountry)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="customerName">{tna.customerName}</Label>
              <Input id="customerName" placeholder={tna.customerNamePlaceholder} value={newAddress.customerName} onChange={(e) => setNewAddress(prev => ({ ...prev, customerName: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="street">{tna.street}</Label>
              <Input id="street" placeholder={tna.streetPlaceholder} value={newAddress.street} onChange={(e) => setNewAddress(prev => ({ ...prev, street: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="streetSecondary">{tna.streetSecondary}</Label>
              <Input id="streetSecondary" placeholder={tna.streetSecondaryPlaceholder} value={newAddress.streetSecondary} onChange={(e) => setNewAddress(prev => ({ ...prev, streetSecondary: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="city">{tna.city}</Label>
                <Input id="city" placeholder={tna.cityPlaceholder} value={newAddress.city} onChange={(e) => setNewAddress(prev => ({ ...prev, city: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="region">{tna.region}</Label>
                <Input id="region" placeholder={tna.regionPlaceholder} value={newAddress.region} onChange={(e) => setNewAddress(prev => ({ ...prev, region: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="postalCode">{tna.postalCode}</Label>
                <Input id="postalCode" placeholder={tna.postalCodePlaceholder} value={newAddress.postalCode} onChange={(e) => setNewAddress(prev => ({ ...prev, postalCode: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{tna.country}</Label>
                <Select value={newAddress.isoCountry} onValueChange={(v) => setNewAddress(prev => ({ ...prev, isoCountry: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.filter(c => c.requiresAddress).map((country) => (
                      <SelectItem key={country.code} value={country.code}>{country.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="friendlyName">{tna.friendlyName}</Label>
              <Input id="friendlyName" placeholder={tna.friendlyNamePlaceholder} value={newAddress.friendlyName} onChange={(e) => setNewAddress(prev => ({ ...prev, friendlyName: e.target.value }))} />
              <p className="text-xs text-muted-foreground">{tna.friendlyNameDescription}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddressDialogOpen(false)}>{tna.cancel}</Button>
            <Button
              onClick={handleCreateAddress}
              disabled={isCreatingAddress || !newAddress.customerName || !newAddress.street || !newAddress.city || !newAddress.postalCode}
            >
              {isCreatingAddress ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />{tna.creating}</>
              ) : (
                <><Plus className="h-4 w-4 mr-1.5" />{tna.create}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

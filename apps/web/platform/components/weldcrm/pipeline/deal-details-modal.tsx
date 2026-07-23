
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Calendar } from '@weldsuite/ui/components/calendar';
import {
  X,
  Check,
  Trash2,
  Loader2,
  Building2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useTranslations } from '@weldsuite/i18n/client';

interface Stage {
  id: string;
  name: string;
  color?: string;
}

interface Customer {
  id: string;
  type?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  companyName?: string;
  tradingName?: string;
  email?: string;
  phone?: string;
  website?: string;
  name?: string;
  domain?: string;
  logoUrl?: string;
}

interface DealDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: Stage[];
  selectedStageId: string;
  customers: Customer[];
  onSubmit: (data: any) => Promise<void>;
  lockedCustomer?: { id: string; name: string };
}

function getCustomerName(customer: Customer): string {
  if (customer.name) return customer.name;
  if (customer.fullName) return customer.fullName;
  if (customer.type === 'b2b' || customer.companyName) {
    if (customer.companyName) return customer.companyName;
    if (customer.tradingName) return customer.tradingName;
  }
  if (customer.firstName || customer.lastName) {
    return `${customer.firstName || ''} ${customer.lastName || ''}`.trim();
  }
  if (customer.email) return customer.email;
  return 'Unknown Customer';
}

export function DealDetailsModal({
  open,
  onOpenChange,
  stages,
  selectedStageId,
  customers,
  onSubmit,
  lockedCustomer,
}: DealDetailsModalProps) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const [probability, setProbability] = useState<string | null>(null);
  const [closeDate, setCloseDate] = useState<Date | undefined>(undefined);
  const [stageId, setStageId] = useState(selectedStageId);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasButtonOverflow, setHasButtonOverflow] = useState(false);

  // Record search state
  const [recordSearchQuery, setRecordSearchQuery] = useState('');
  const [searchedCustomers, setSearchedCustomers] = useState<Customer[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const buttonContainerRef = useRef<HTMLDivElement>(null);
  const titleTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descriptionTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isSubmittingRef = useRef(false);
  const recordSearchInputRef = useRef<HTMLInputElement>(null);

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      isSubmittingRef.current = false;
      setStageId(selectedStageId);
      resetForm();
      // Pre-select locked customer
      if (lockedCustomer) {
        setSelectedCustomer({ id: lockedCustomer.id, name: lockedCustomer.name } as Customer);
      }
    }
  }, [open, selectedStageId, lockedCustomer]);

  // Auto-resize textareas when dialog opens
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        if (titleTextareaRef.current) {
          titleTextareaRef.current.style.height = 'auto';
          titleTextareaRef.current.style.height = Math.min(titleTextareaRef.current.scrollHeight, 200) + 'px';
        }
        if (descriptionTextareaRef.current) {
          descriptionTextareaRef.current.style.height = 'auto';
          descriptionTextareaRef.current.style.height = Math.min(descriptionTextareaRef.current.scrollHeight, 350) + 'px';
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (buttonContainerRef.current) {
      const hasOverflow = buttonContainerRef.current.scrollWidth > buttonContainerRef.current.clientWidth;
      setHasButtonOverflow(hasOverflow);
    }
  }, [open, value, probability, closeDate, stageId, selectedCustomer]);

  // Search customers with debouncing
  useEffect(() => {
    const fetchCustomers = async () => {
      setIsSearching(true);
      try {
        const client = await getClient();
        // `/crm/customers` was retired with the Companies/People refactor.
        // app-api pages by cursor, so `page`/`pageSize` collapse to `limit`,
        // and there's no `success` flag — a failure throws instead.
        const search = recordSearchQuery?.trim();
        const result = await client.get<{ data: any[] }>(
          `/companies?limit=50${search ? `&search=${encodeURIComponent(search)}` : ''}`,
        );
        setSearchedCustomers(result.data || []);
      } catch (error) {
        console.error('Failed to fetch customers:', error);
        setSearchedCustomers([]);
      } finally {
        setIsSearching(false);
      }
    };

    const timeoutId = setTimeout(fetchCustomers, 300);
    return () => clearTimeout(timeoutId);
  }, [recordSearchQuery, getClient]);

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setValue('');
    setProbability(null);
    setCloseDate(undefined);
    setSelectedCustomer(null);
    setRecordSearchQuery('');
    setSearchedCustomers([]);
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = async () => {
    if (!title.trim() || !selectedCustomer?.id || isSubmittingRef.current) return;

    isSubmittingRef.current = true;
    setLoading(true);

    try {
      await onSubmit({
        name: title.trim(),
        customerId: selectedCustomer.id,
        amount: value ? parseFloat(value) : 1,
        probability: probability ? parseInt(probability) : undefined,
        closeDate: closeDate ? closeDate.toISOString() : undefined,
        description: description || undefined,
        status: 'open',
        stageId,
      });

      handleClose();
    } catch (error) {
      console.error('Failed to create deal:', error);
    } finally {
      setLoading(false);
      isSubmittingRef.current = false;
    }
  };

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null, maxHeight: number) => {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (title.trim() && !loading && !isSubmittingRef.current) {
        handleSubmit();
      }
    }
  };

  const probabilityOptions = [
    { value: '10', label: '10%' },
    { value: '25', label: '25%' },
    { value: '50', label: '50%' },
    { value: '75', label: '75%' },
    { value: '90', label: '90%' },
    { value: '100', label: '100%' },
  ];

  const filteredCustomers = searchedCustomers.filter(customer => {
    if (!customer) return false;
    const name = getCustomerName(customer);
    return name && name !== 'Unknown Customer';
  });

  const selectedStageName = stages.find(s => s.id === stageId)?.name || t('sweep.weldcrm.dealDetailsModal.stage');

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-border">
          <DialogTitle className="text-base font-semibold">{t('sweep.weldcrm.dealDetailsModal.createDeal')}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Deal Input */}
        <div className="px-4 pt-3 pb-[7px]">
          <textarea
            ref={titleTextareaRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              resizeTextarea(e.target, 200);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('sweep.weldcrm.dealDetailsModal.dealNamePlaceholder')}
            className="w-full text-sm font-medium border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[200px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
            rows={1}
            autoFocus
          />
          <div className="border-b border-gray-100 dark:border-border my-2 -mx-4" />
          <textarea
            ref={descriptionTextareaRef}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              resizeTextarea(e.target, 350);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('sweep.weldcrm.dealDetailsModal.addDescriptionPlaceholder')}
            className="w-full text-sm text-gray-600 dark:text-muted-foreground border-none outline-none bg-transparent placeholder:text-gray-400 resize-none overflow-y-auto max-h-[350px] mt-[5px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
            rows={1}
          />
        </div>

        {/* Bottom Bar */}
        <div className="flex items-center justify-between px-4 pt-0 pb-0 border-t border-gray-100 dark:border-border gap-2 w-full overflow-hidden">
          <div
            ref={buttonContainerRef}
            className={cn(
              "flex items-center gap-1 overflow-x-auto min-w-0 flex-shrink pb-7 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&>*]:flex-shrink-0",
              hasButtonOverflow ? "[&>*]:translate-y-[15px]" : "[&>*]:translate-y-[14px]"
            )}>

            {/* Value */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 text-xs font-normal",
                    value && "bg-green-100 text-green-800 border-green-200 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
                  )}
                >
                  {value ? `$${Number(value).toLocaleString()}` : t('sweep.weldcrm.dealDetailsModal.value')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-2" align="start">
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="0"
                    className="h-8 text-sm"
                    autoFocus
                  />
                </div>
                {value && (
                  <>
                    <div className="h-px bg-gray-200 dark:bg-accent my-1.5" />
                    <Button
                      variant="ghost"
                      onClick={() => setValue('')}
                      className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      <span>{t('sweep.weldcrm.dealDetailsModal.clear')}</span>
                    </Button>
                  </>
                )}
              </PopoverContent>
            </Popover>

            {/* Probability */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 text-xs font-normal",
                    probability && "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800"
                  )}
                >
                  {probability ? `${probability}%` : t('sweep.weldcrm.dealDetailsModal.probability')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" align="start">
                {probabilityOptions.map((opt) => (
                  <Button
                    key={opt.value}
                    variant="ghost"
                    onClick={() => setProbability(opt.value)}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded"
                  >
                    <span>{opt.label}</span>
                    {probability === opt.value && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))}
                {probability && (
                  <>
                    <div className="h-px bg-gray-200 dark:bg-accent my-1" />
                    <Button
                      variant="ghost"
                      onClick={() => setProbability(null)}
                      className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      <span>{t('sweep.weldcrm.dealDetailsModal.clear')}</span>
                    </Button>
                  </>
                )}
              </PopoverContent>
            </Popover>

            {/* Close Date */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs font-normal">
                  {closeDate ? format(closeDate, 'MMM d') : t('sweep.weldcrm.dealDetailsModal.closeDate')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={closeDate}
                  onSelect={setCloseDate}
                  initialFocus
                />
                {closeDate && (
                  <div className="p-1 border-t border-gray-200 dark:border-border">
                    <Button
                      variant="ghost"
                      onClick={() => setCloseDate(undefined)}
                      className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      <span>{t('sweep.weldcrm.dealDetailsModal.clear')}</span>
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>

            {/* Stage */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 text-xs font-medium",
                    "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800"
                  )}
                >
                  {selectedStageName}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" align="start">
                {stages.map((stage) => (
                  <Button
                    key={stage.id}
                    variant="ghost"
                    onClick={() => setStageId(stage.id)}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded"
                  >
                    <span>{stage.name}</span>
                    {stageId === stage.id && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))}
              </PopoverContent>
            </Popover>

            {/* Record (Customer) */}
            {lockedCustomer ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs font-normal bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800 cursor-default gap-1.5"
                disabled
              >
                <div className="w-4 h-4 rounded bg-purple-200 dark:bg-purple-800 flex items-center justify-center flex-shrink-0">
                  <Building2 className="h-2.5 w-2.5" />
                </div>
                {lockedCustomer.name}
              </Button>
            ) : (
            <Popover onOpenChange={(isOpen) => {
              if (isOpen) {
                setRecordSearchQuery('');
              }
            }}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 text-xs font-normal gap-1.5",
                    selectedCustomer && "bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800 pl-1"
                  )}
                >
                  {selectedCustomer && (() => {
                    const name = getCustomerName(selectedCustomer);
                    return (
                      <Avatar className="h-5 w-5 !rounded-[6px]">
                        {selectedCustomer.logoUrl && (
                          <AvatarImage src={selectedCustomer.logoUrl} alt={name} className="!rounded-[6px]" />
                        )}
                        <AvatarFallback className="!rounded-[6px] text-[10px] font-medium bg-purple-200/60 dark:bg-purple-900/60 text-purple-800 dark:text-purple-300">
                          {name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    );
                  })()}
                  <span>{selectedCustomer ? getCustomerName(selectedCustomer) : t('sweep.weldcrm.dealDetailsModal.selectRecord')}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[260px] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    ref={recordSearchInputRef}
                    placeholder={t('sweep.weldcrm.dealDetailsModal.searchRecords')}
                    className="h-9"
                    value={recordSearchQuery}
                    onValueChange={setRecordSearchQuery}
                  />
                  <CommandList
                    onWheel={(e) => {
                      e.currentTarget.scrollTop += e.deltaY;
                    }}
                  >
                    <CommandEmpty>
                      {isSearching ? (
                        <span className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t('sweep.weldcrm.dealDetailsModal.searching')}
                        </span>
                      ) : (
                        t('sweep.weldcrm.dealDetailsModal.noRecordsFound')
                      )}
                    </CommandEmpty>
                    <CommandGroup className="px-1 py-1">
                      {filteredCustomers.map((customer) => {
                        const name = getCustomerName(customer);
                        return (
                          <CommandItem
                            key={customer.id}
                            value={`${name} ${customer.id}`}
                            onSelect={() => {
                              if (selectedCustomer?.id === customer.id) {
                                setSelectedCustomer(null);
                              } else {
                                setSelectedCustomer(customer);
                              }
                            }}
                            className="flex items-center justify-between gap-2 px-1.5"
                          >
                            <span className="flex items-center gap-2 min-w-0 flex-1">
                              <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
                                {customer.logoUrl && (
                                  <AvatarImage src={customer.logoUrl} alt={name} className="!rounded-[7px]" />
                                )}
                                <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                                  {name.charAt(0).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <span className="truncate">{name}</span>
                            </span>
                            {selectedCustomer?.id === customer.id && (
                              <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                    {selectedCustomer && (
                      <div className="p-1">
                        <div className="h-px bg-gray-200 dark:bg-accent my-1" />
                        <Button
                          variant="ghost"
                          onClick={() => setSelectedCustomer(null)}
                          className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          <span>{t('sweep.weldcrm.dealDetailsModal.clearAll')}</span>
                        </Button>
                      </div>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!title.trim() || !selectedCustomer?.id || loading}
              className="h-7 text-xs px-3 bg-black hover:bg-gray-800 text-white"
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                t('sweep.weldcrm.dealDetailsModal.createDeal')
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}


import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Search, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useEnrollCustomers } from '@/hooks/queries/use-sequences-queries';

interface EnrollCustomersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sequenceId: string;
  onComplete: () => void;
}

interface CustomerOption {
  id: string;
  name: string;
  type?: string;
}

/**
 * Loosely-typed shape of a `/companies` search row. `fullName`/`firstName`/
 * `lastName` are legacy contact-style fields kept as a fallback for rows
 * that predate the Companies/People merge; the current `Company` schema
 * only guarantees `name`/`displayName`.
 */
interface CompanySearchRow {
  id: string;
  fullName?: string;
  name?: string;
  tradingName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  type?: string;
}

export function EnrollCustomersDialog({
  open,
  onOpenChange,
  sequenceId,
  onComplete,
}: EnrollCustomersDialogProps) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [search, setSearch] = useState('');
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const fetchCustomers = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const client = await getClient();
      // `/crm/customers` was retired with the Companies/People refactor —
      // companies are the identity layer now. Offset paging (`page`/`pageSize`)
      // gave way to cursor paging, so a plain `limit` is all we need here.
      const searchParam = query?.trim() ? `&search=${encodeURIComponent(query.trim())}` : '';
      const result = await client.get<{ data: CompanySearchRow[] }>(`/companies?limit=50${searchParam}`);
      const customersList = result.data || [];
      // Map to CustomerOption format
      const getCustomerName = (c: CompanySearchRow): string => {
        if (c.fullName) return c.fullName;
        if (c.name) return c.name;
        if (c.tradingName) return c.tradingName;
        if (c.firstName || c.lastName) return `${c.firstName || ''} ${c.lastName || ''}`.trim();
        return c.email || 'Unknown Customer';
      };
      setCustomers(
        customersList.map((c) => ({
          id: c.id,
          name: getCustomerName(c),
          type: c.type,
        }))
      );
    } catch {
      // Ignore
    } finally {
      setIsSearching(false);
      setHasSearched(true);
    }
  }, [getClient]);

  // Fetch initial customers when dialog opens
  useEffect(() => {
    if (open) {
      fetchCustomers('');
      setSelectedIds(new Set());
      setSearch('');
      setHasSearched(false);
    }
  }, [open, fetchCustomers]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const timeout = setTimeout(() => {
      fetchCustomers(search);
    }, 300);
    return () => clearTimeout(timeout);
  }, [search, open, fetchCustomers]);

  const handleToggle = (customerId: string) => {
    const next = new Set(selectedIds);
    if (next.has(customerId)) {
      next.delete(customerId);
    } else {
      next.add(customerId);
    }
    setSelectedIds(next);
  };

  const enrollMutation = useEnrollCustomers();

  const handleEnroll = async () => {
    if (selectedIds.size === 0) return;
    setIsEnrolling(true);
    try {
      const result = await enrollMutation.mutateAsync({
        sequenceId,
        customerIds: Array.from(selectedIds),
      });
      const enrolled = result?.data?.enrolled ?? 0;
      toast.success(
        enrolled === 0
          ? t('crm.enrollCustomersDialog.alreadyEnrolled')
          : enrolled === 1
            ? t('crm.enrollCustomersDialog.enrolledSuccess', { count: enrolled })
            : t('crm.enrollCustomersDialog.enrolledSuccessPlural', { count: enrolled }),
      );
      onComplete();
    } catch {
      toast.error(t('crm.enrollCustomersDialog.enrollFailed'));
    } finally {
      setIsEnrolling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('crm.enrollCustomersDialog.dialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder={t('crm.enrollCustomersDialog.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Customer list */}
          <div className="border rounded-md max-h-[300px] overflow-auto">
            {isSearching && !hasSearched ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              </div>
            ) : customers.length === 0 ? (
              <div className="text-sm text-gray-500 text-center py-8">
                {hasSearched ? t('crm.enrollCustomersDialog.noCustomersFound') : t('crm.enrollCustomersDialog.typeToSearch')}
              </div>
            ) : (
              customers.map((customer) => (
                <label
                  key={customer.id}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-secondary/50 border-b last:border-b-0 border-gray-200/70 dark:border-border',
                    selectedIds.has(customer.id) && 'bg-primary/5'
                  )}
                >
                  <Checkbox
                    checked={selectedIds.has(customer.id)}
                    onCheckedChange={() => handleToggle(customer.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
                      {customer.name}
                    </p>
                    {customer.type && (
                      <p className="text-xs text-gray-500">
                        {customer.type === 'b2b' ? t('crm.enrollCustomersDialog.customerTypeCompany') : t('crm.enrollCustomersDialog.customerTypeIndividual')}
                      </p>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>

          {selectedIds.size > 0 && (
            <p className="text-sm text-gray-500">
              {selectedIds.size !== 1
                ? t('crm.enrollCustomersDialog.selectedCountPlural', { count: selectedIds.size })
                : t('crm.enrollCustomersDialog.selectedCount', { count: selectedIds.size })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('crm.enrollCustomersDialog.cancelButton')}
          </Button>
          <Button
            onClick={handleEnroll}
            disabled={selectedIds.size === 0 || isEnrolling}
          >
            {isEnrolling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                {t('crm.enrollCustomersDialog.enrollingLabel')}
              </>
            ) : (
              selectedIds.size !== 1
                ? t('crm.enrollCustomersDialog.enrollButtonPlural', { count: selectedIds.size || 0 })
                : t('crm.enrollCustomersDialog.enrollButton', { count: selectedIds.size })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

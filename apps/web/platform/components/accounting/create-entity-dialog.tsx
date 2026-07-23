import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Loader2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';

interface Jurisdiction {
  code: string;
  name: string;
}

const JURISDICTION_DEFAULTS: Record<string, { locale: string; baseCurrency: string; vatHint: string }> = {
  NL: { locale: 'nl-NL', baseCurrency: 'EUR', vatHint: 'NL123456789B01' },
};

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN'];

interface CreateEntityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Show "Welcome to WeldBooks" copy when this is the first entity. */
  firstEntity?: boolean;
}

/**
 * Minimal create-entity flow. 3 inputs and a jurisdiction dropdown — everything else
 * is defaulted from the jurisdiction adapter. On success, the new entity is selected
 * automatically so the rest of the module is usable immediately.
 */
export function CreateEntityDialog({ open, onOpenChange, firstEntity }: CreateEntityDialogProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { setEntityId } = useCurrentAccountingEntity();

  const [name, setName] = useState('');
  const [jurisdictionCode, setJurisdictionCode] = useState('NL');
  const [baseCurrency, setBaseCurrency] = useState('EUR');
  const [vatNumber, setVatNumber] = useState('');

  const { data: jurisdictions = [] } = useQuery<Jurisdiction[]>({
    queryKey: ['accounting', 'jurisdictions'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: Jurisdiction[] } | Jurisdiction[]>(
        '/accounting-entities/jurisdictions',
      );
      return Array.isArray(res) ? res : res.data ?? [];
    },
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const defaults = JURISDICTION_DEFAULTS[jurisdictionCode] ?? {
        locale: 'en-US',
        baseCurrency,
        vatHint: '',
      };
      return weldbooksApi.post<{ data: { id: string } } | { id: string }>('/accounting-entities', {
        name,
        jurisdictionCode,
        baseCurrency,
        locale: defaults.locale,
        taxIdentifiers: vatNumber ? { vatNumber } : undefined,
        isDefault: true,
        seedDefaults: true,
      });
    },
    onSuccess: (res) => {
      const created = (res as any).data ?? res;
      if (created?.id) setEntityId(created.id);
      queryClient.invalidateQueries({ queryKey: ['accounting'] });
      setName('');
      setVatNumber('');
      onOpenChange(false);
    },
  });

  const vatHint = JURISDICTION_DEFAULTS[jurisdictionCode]?.vatHint ?? '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {firstEntity ? t('sweep.weldbooks.createEntity.welcomeTitle') : t('sweep.weldbooks.createEntity.newEntityTitle')}
          </DialogTitle>
          <DialogDescription>
            {firstEntity
              ? t('sweep.weldbooks.createEntity.welcomeDescription')
              : t('sweep.weldbooks.createEntity.newEntityDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="entity-name">{t('sweep.weldbooks.createEntity.nameLabel')}</Label>
            <Input
              id="entity-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="WeldCorp BV"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('sweep.weldbooks.createEntity.jurisdictionLabel')}</Label>
              <Select
                value={jurisdictionCode}
                onValueChange={(v) => {
                  setJurisdictionCode(v);
                  const d = JURISDICTION_DEFAULTS[v];
                  if (d) setBaseCurrency(d.baseCurrency);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {jurisdictions.length === 0 ? (
                    <SelectItem value="NL">{t('sweep.weldbooks.createEntity.netherlandsOption')}</SelectItem>
                  ) : (
                    jurisdictions.map((j) => (
                      <SelectItem key={j.code} value={j.code}>
                        {j.name} ({j.code})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('sweep.weldbooks.createEntity.currencyLabel')}</Label>
              <Select value={baseCurrency} onValueChange={setBaseCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="entity-vat">{t('sweep.weldbooks.createEntity.vatLabel')} <span className="text-muted-foreground">({t('sweep.weldbooks.createEntity.optional')})</span></Label>
            <Input
              id="entity-vat"
              value={vatNumber}
              onChange={(e) => setVatNumber(e.target.value)}
              placeholder={vatHint || t('sweep.weldbooks.createEntity.vatPlaceholder')}
            />
          </div>
        </div>

        {createMutation.isError ? (
          <p className="text-sm text-destructive">
            {(createMutation.error as Error)?.message ?? t('sweep.weldbooks.createEntity.createFailed')}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
            {t('sweep.weldbooks.cancel')}
          </Button>
          <Button onClick={() => createMutation.mutate()} disabled={!name || createMutation.isPending}>
            {createMutation.isPending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" />{t('sweep.weldbooks.createEntity.creating')}</>
            ) : (
              t('sweep.weldbooks.createEntity.createButton')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
